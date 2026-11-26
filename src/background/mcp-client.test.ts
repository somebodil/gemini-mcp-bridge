import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startTestServer, type TestServer } from "../../e2e/test-server.ts";
import { McpClient, McpError, resultToText, SseParser } from "./mcp-client.ts";

const dir = mkdtempSync(join(tmpdir(), "gmb-client-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("against a stateless server with JSON answers and a token", () => {
  let s: TestServer;
  before(async () => {
    s = await startTestServer({ token: "secret" });
    writeFileSync(join(dir, "f.txt"), "hello");
  });
  after(() => s.close());

  it("connects, lists, calls", async () => {
    const c = new McpClient({ url: s.url, headers: { authorization: "Bearer secret" } });
    const info = await c.connect();
    assert.equal(info.serverInfo?.name, "test-server");
    assert.equal(info.instructions, "A server for tests.");
    assert.deepEqual(
      (await c.listTools()).map((t) => t.name),
      ["run_command", "read_file", "write_file", "list_directory"],
    );
    assert.equal(resultToText(await c.callTool("read_file", { path: join(dir, "f.txt") }, 5000)), "hello");
    const missing = await c.callTool("read_file", { path: join(dir, "nope") }, 5000);
    assert.equal(missing.isError, true);
  });

  it("reports a wrong token as HTTP 401 with a hint", async () => {
    const c = new McpClient({ url: s.url, headers: { authorization: "Bearer wrong" } });
    await assert.rejects(c.connect(), (e: unknown) => e instanceof McpError && e.status === 401 && /Check the token/.test(e.message));
  });
});

describe("against a server with sessions and SSE answers", () => {
  let s: TestServer;
  before(async () => {
    s = await startTestServer({ sessions: true });
  });
  after(() => s.close());

  it("reads streamed answers, sends the session id, and connects again when the server forgets it", async () => {
    let session = "";
    let streamed = false;
    const c = new McpClient({
      url: s.url,
      fetch: async (input, init) => {
        session = new Headers(init?.headers).get("mcp-session-id") ?? session;
        const res = await fetch(input, init);
        if (res.headers.get("content-type")?.includes("text/event-stream")) streamed = true;
        return res;
      },
    });
    await c.connect();
    assert.equal((await c.listTools()).length, 4);
    assert.ok(session, "the session id is sent after initialize");
    assert.ok(streamed, "the server answered with SSE");
    assert.match(resultToText(await c.callTool("run_command", { command: "printf 'h\\303\\251 \\355\\225\\234'" }, 5000)), /hé 한/);
    const first = session;
    s.forgetSessions();
    assert.match(resultToText(await c.callTool("run_command", { command: "echo again" }, 5000)), /again/);
    assert.notEqual(session, first);
  });
});

describe("failures", () => {
  it("times out", async () => {
    const hang = createServer(() => undefined);
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const c = new McpClient({ url: `http://127.0.0.1:${(hang.address() as AddressInfo).port}/mcp` });
    await assert.rejects(c.connect(300), (e: unknown) => e instanceof McpError && e.kind === "timeout");
    hang.closeAllConnections();
    hang.close();
  });

  it("says when nothing listens", async () => {
    const c = new McpClient({ url: "http://127.0.0.1:1/mcp" });
    await assert.rejects(c.connect(2000), (e: unknown) => e instanceof McpError && e.kind === "network" && /local server running/.test(e.message));
  });

  it("tells the server when a call is cancelled, and stops waiting", async () => {
    const s = await startTestServer();
    try {
      const c = new McpClient({ url: s.url });
      await c.connect();
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 200);
      await assert.rejects(c.callTool("run_command", { command: "sleep 3" }, 10_000, ctrl.signal), (e: unknown) => e instanceof McpError && e.message === "Cancelled.");
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(s.methods.includes("notifications/cancelled"), s.methods.join(","));
      await assert.rejects(c.callTool("x", {}, 1000, ctrl.signal), (e: unknown) => e instanceof McpError && e.message === "Cancelled.");
    } finally {
      s.close();
    }
  });
});

/** A raw HTTP server answering each JSON-RPC message with `answer(message)`; it records what it was sent. */
async function rawServer(answer: (m: { id?: number; method?: string; params?: Record<string, unknown> }, res: import("node:http").ServerResponse) => void) {
  const got: { method?: string; id?: number; result?: unknown; httpMethod: string }[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const m = (raw ? JSON.parse(raw) : {}) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      got.push({ ...m, httpMethod: req.method ?? "" });
      if (req.method === "DELETE" || m.id === undefined || m.result !== undefined) return void res.writeHead(202).end();
      if (m.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "raw" } } }));
      }
      answer(m, res);
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, got, close: () => server.close() };
}

describe("protocol details", () => {
  it("answers a server's ping that comes inside a streamed answer", async () => {
    const s = await rawServer((m, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 900, method: "ping" })}\n\n`);
      setTimeout(() => res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "after ping" }] } })}\n\n`), 100);
    });
    try {
      const c = new McpClient({ url: s.url });
      assert.equal(resultToText(await c.callTool("t", {}, 5000)), "after ping");
      const pong = s.got.find((g) => g.id === 900 && g.result !== undefined);
      assert.deepEqual(pong?.result, {});
    } finally {
      s.close();
    }
  });

  it("reads every page of a tool list, and answers given as a batch", async () => {
    const s = await rawServer((m, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const cursor = m.params?.cursor;
      const page = cursor ? { tools: [{ name: "b" }] } : { tools: [{ name: "a" }], nextCursor: "p2" };
      // the answer in a batch, after a notification
      res.end(JSON.stringify([{ jsonrpc: "2.0", method: "notifications/message", params: {} }, { jsonrpc: "2.0", id: m.id, result: page }]));
    });
    try {
      const c = new McpClient({ url: s.url });
      assert.deepEqual(
        (await c.listTools()).map((t) => t.name),
        ["a", "b"],
      );
    } finally {
      s.close();
    }
  });

  it("writes every error status to the console, with what the server said, and skips events without data", async (t) => {
    const errors = t.mock.method(console, "error", () => undefined);
    const s = await rawServer((m, res) => {
      if (m.method === "tools/call") {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null }));
      }
      // a priming event without data first, as a server that can resume streams sends it
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`id: 1\ndata: \n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [] } })}\n\n`);
    });
    try {
      const c = new McpClient({ url: s.url });
      assert.deepEqual(await c.listTools(), []);
      assert.equal(errors.mock.callCount(), 0);
      await assert.rejects(c.callTool("t", {}, 5000), /HTTP 400: .*Parse error: Invalid JSON/);
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0].arguments[0]), /^\[MCP Bridge\] http:\/\/127\.0\.0\.1:\d+\/mcp answered tools\/call with HTTP 400: .*Parse error: Invalid JSON/);
    } finally {
      s.close();
    }
  });

  it("ends its session on close", async () => {
    const s = await rawServer((m, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [] } }));
    });
    try {
      const c = new McpClient({ url: s.url });
      await c.listTools();
      await c.close();
      assert.equal(c.connected, false);
      assert.ok(s.got.some((g) => g.httpMethod === "DELETE"));
    } finally {
      s.close();
    }
  });
});

describe("pieces", () => {
  it("splits SSE in any chunking, with CRLF and multi-line data", () => {
    const p = new SseParser();
    const got = [...p.push("event: message\r\ndata: {\"a\":"), ...p.push("1}\r\n\r\ndata: x\ndata: y\n"), ...p.push("\n: comment\n\n")];
    assert.deepEqual(got, ['{"a":1}', "x\ny"]);
    // CR and LF of one line ending in two chunks
    const q = new SseParser();
    assert.deepEqual([...q.push('data: {"a":\r'), ...q.push("\ndata: 1}\r\n\r\n")], ['{"a":\n1}']);
  });

  it("turns results into text", () => {
    assert.equal(
      resultToText({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "A".repeat(4096), mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///x", text: "inline" } },
          { type: "resource", resource: { uri: "file:///y", blob: "AA", mimeType: "application/pdf" } },
          { type: "resource_link", uri: "file:///z", name: "z" },
        ],
      }),
      "a\n[image: image/png, 3 KB, not shown]\ninline\n[resource file:///y (application/pdf), not shown]\n[link: z file:///z]",
    );
    assert.equal(resultToText({ content: [], structuredContent: { n: 1 } }), '{\n  "n": 1\n}');
  });
});
