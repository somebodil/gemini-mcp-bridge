// An MCP server for the tests, built with the official SDK: the four tools of local-mcp-bridge-server, in
// simple form, over Streamable HTTP. Stateless with JSON answers, or with sessions and SSE answers. Its folders are
// read at each request (with sessions: at each new session), so a test that changes them has a server that was
// started again elsewhere.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

const obj = (properties: Record<string, object>, required: string[]) => ({ type: "object" as const, properties, required });

export const TOOLS: Tool[] = [
  { name: "run_command", description: "Run a command in the shell of the user's computer.", inputSchema: obj({ command: { type: "string" } }, ["command"]) },
  { name: "read_file", description: "Read a text file.", inputSchema: obj({ path: { type: "string" } }, ["path"]) },
  { name: "write_file", description: "Write a text file.", inputSchema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) },
  { name: "list_directory", description: "List the files and folders in a folder.", inputSchema: obj({ path: { type: "string" } }, ["path"]) },
];

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export interface Folders {
  /** Where a path of the file tools that starts with ~ goes (the harness's folder), instead of the home folder of this computer. */
  home?: string;
  /** The working folder: relative paths and run_command start there, and the instructions name it, as local-mcp-bridge-server's do. */
  work?: string;
}

async function run(name: string, a: Record<string, unknown>, { home, work }: Folders): Promise<CallToolResult> {
  const path = (v: unknown) => {
    const s = String(v);
    if (home && (s === "~" || s.startsWith("~/"))) return join(home, s.slice(1));
    return work ? resolve(work, s) : s;
  };
  try {
    switch (name) {
      case "run_command":
        return await new Promise((done) =>
          execFile("/bin/sh", ["-c", String(a.command)], { cwd: work }, (err, stdout, stderr) => {
            const code = err && typeof err.code === "number" ? err.code : 0;
            const parts = [`exit code: ${code}`];
            if (stdout) parts.push(`--- stdout ---\n${stdout.replace(/\n$/, "")}`);
            if (stderr) parts.push(`--- stderr ---\n${stderr.replace(/\n$/, "")}`);
            done(text(parts.join("\n")));
          }),
        );
      case "read_file":
        return text(await readFile(path(a.path), "utf8"));
      case "write_file":
        await writeFile(path(a.path), String(a.content));
        return text(`Wrote ${String(a.path)}.`);
      case "list_directory": {
        const dir = path(a.path);
        const lines = [dir];
        for (const e of await readdir(dir, { withFileTypes: true })) {
          lines.push(e.isDirectory() ? `[DIR]  ${e.name}/` : `[FILE] ${e.name} (${(await stat(join(dir, e.name))).size} bytes)`);
        }
        return text(lines.join("\n"));
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

function mcp(calls: string[], name: string, folders: Folders): Server {
  const { work } = folders;
  const instructions = work ? `A server for tests.\nWorking folder: ${work}. Relative paths in the tools start there; ~ is the home folder.` : "A server for tests.";
  const s = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} }, instructions });
  s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, (req) => {
    calls.push(req.params.name);
    return run(req.params.name, req.params.arguments ?? {}, folders);
  });
  return s;
}

export interface TestServer {
  url: string;
  /** Names of the tools called, in order. */
  calls: string[];
  /** JSON-RPC methods received (requests and notifications), and "DELETE" for a session ended. */
  methods: string[];
  /** Lines of the performance log posted to /perf (answered as local-mcp-bridge-server does). */
  perf: string[];
  /** The server's folders (see the top of the file). */
  folders: Folders;
  http: HttpServer;
  /** Forgets all sessions, as a restarted server would (sessions mode only). */
  forgetSessions(): void;
  close(): void;
}

/** `name`: the server's name in its answer to initialize (the extension sends the performance log only to
 * local-mcp-bridge-server, by either of its names). */
export async function startTestServer(opts: { token?: string; sessions?: boolean; name?: string } & Folders = {}): Promise<TestServer> {
  const folders: Folders = { home: opts.home, work: opts.work };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const calls: string[] = [];
  const methods: string[] = [];
  const perf: string[] = [];
  const name = opts.name ?? "test-server";
  const http = createServer((req, res) => {
    void (async () => {
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return void res.writeHead(401).end("Missing or wrong token");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.url === "/perf") {
        perf.push(...Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean));
        return void res.writeHead(200).end("/home/test/.config/local-mcp-bridge-server/perf.log");
      }
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      if (req.method === "DELETE") methods.push("DELETE");
      for (const m of Array.isArray(body) ? body : [body]) if (m && typeof (m as { method?: unknown }).method === "string") methods.push((m as { method: string }).method);
      if (!opts.sessions) {
        const server = mcp(calls, name, folders);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => void transport.close());
        await server.connect(transport);
        return void (await transport.handleRequest(req, res, body));
      }
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (sid) return void res.writeHead(404).end("Session not found");
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, t),
        });
        await mcp(calls, name, folders).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    })();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    calls,
    methods,
    perf,
    folders,
    http,
    forgetSessions: () => sessions.clear(),
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}
