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

  it("can be cancelled", async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const c = new McpClient({ url: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/mcp` });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    // connect has no signal; a call does: fake a connected client
    (c as unknown as { info: object }).info = { protocolVersion: "2025-06-18" };
    await assert.rejects(c.callTool("x", {}, 10_000, ctrl.signal), (e: unknown) => e instanceof McpError && e.message === "Cancelled.");
    slow.closeAllConnections();
    slow.close();
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
