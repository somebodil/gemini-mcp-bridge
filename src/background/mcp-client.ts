// A small MCP client for the Streamable HTTP transport, written for an extension service worker.
//
// The official SDK is not used here: its client validates tool output with Ajv, which compiles schemas with
// `new Function`, and Manifest V3 forbids that. The extension needs only initialize, tools/list and
// tools/call, which this file does by the specification (2025-06-18): every message is a POST, the answer is
// JSON or an SSE stream, the server may give a session id that later requests carry.

import pkg from "../../package.json" with { type: "json" };
import type { ToolInfo } from "../shared/protocol.ts";
import { failed, problem } from "../shared/report.ts";

const CLIENT_INFO = { name: "gemini-mcp-bridge", version: pkg.version };
const PROTOCOL_VERSION = "2025-06-18";

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

export interface CallToolResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface InitializeResult {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  readonly kind: "http" | "rpc" | "network" | "timeout" | "protocol";
  readonly status?: number;
  constructor(kind: McpError["kind"], message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

interface McpClientOptions {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class McpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 1;
  info: InitializeResult | undefined;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get connected(): boolean {
    return this.info !== undefined;
  }

  /** Whether the server gave a session (a server without sessions takes each request on its own). */
  get hasSession(): boolean {
    return this.sessionId !== undefined;
  }

  async connect(timeoutMs = 10_000): Promise<InitializeResult> {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.info = undefined;
    const result = (await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      timeoutMs,
    )) as InitializeResult;
    if (!result || typeof result.protocolVersion !== "string") throw new McpError("protocol", "The server's answer to initialize has no protocolVersion.");
    this.protocolVersion = result.protocolVersion;
    this.info = result;
    await this.notify("notifications/initialized");
    return result;
  }

  async listTools(timeoutMs = 10_000): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = (await this.withSession(() => this.request("tools/list", cursor ? { cursor } : {}, timeoutMs))) as {
        tools?: ToolInfo[];
        nextCursor?: string;
      };
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<CallToolResult> {
    return (await this.withSession(() => this.request("tools/call", { name, arguments: args }, timeoutMs, signal))) as CallToolResult;
  }

  /** Ends the session on the server when it gave one (servers may refuse with 405; that is fine). */
  async close(): Promise<void> {
    const sid = this.sessionId;
    this.info = undefined;
    this.sessionId = undefined;
    if (!sid) return;
    try {
      await this.fetchFn(this.url, { method: "DELETE", headers: { ...this.headers, "mcp-session-id": sid } });
    } catch {
      // the server may be gone already
    }
  }

  /** A server that restarted forgets the session and answers 404: connect again once and repeat the request. */
  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.connected) await this.connect();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof McpError && e.kind === "http" && e.status === 404 && this.sessionId) {
        await this.connect();
        return await fn();
      }
      throw e;
    }
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    return h;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const { res, done } = await this.post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, 10_000);
    await res.body?.cancel();
    done();
  }

  private async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new McpError("network", "Cancelled.");
    const id = this.nextId++;
    // when the caller cancels, tell the server, so that it stops the work (a server without sessions stops
    // anyway when the connection closes, which a timeout does too)
    const onAbort = () =>
      void this.notify("notifications/cancelled", { requestId: id, reason: "The user's page went away or the call timed out." }).catch(failed(`Could not tell ${this.url} to stop ${method}.`));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.requestOnce(id, method, params, timeoutMs, signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async requestOnce(id: number, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const { res, done } = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    let message: JsonRpcMessage | undefined;
    try {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream")) {
        message = await this.readStream(res, id);
      } else {
        const body = (await res.json().catch(() => {
          throw new McpError("protocol", `The server's answer to ${method} is not JSON.`);
        })) as JsonRpcMessage | JsonRpcMessage[];
        message = (Array.isArray(body) ? body : [body]).find((m) => m.id === id);
      }
    } finally {
      done();
    }
    if (!message) throw new McpError("protocol", `The server sent no answer to ${method}.`);
    if (message.error) throw new McpError("rpc", `${message.error.message} (code ${message.error.code})`);
    return message.result;
  }

  /** Sends one message. `done` must be called when the answer has been read: it stops the timer. */
  private async post(body: JsonRpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<{ res: Response; done: () => void }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new McpError("timeout", `No answer within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    const onAbort = () => ctrl.abort(new McpError("network", "Cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    let res: Response;
    try {
      res = await this.fetchFn(this.url, { method: "POST", headers: this.baseHeaders(), body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      done();
      if (ctrl.signal.reason instanceof McpError) throw ctrl.signal.reason;
      throw new McpError("network", `Cannot reach ${this.url} (${e instanceof Error ? e.message : String(e)}). Is the local server running?`);
    }
    if (!res.ok) {
      done();
      const text = (await res.text().catch(() => "")).slice(0, 300);
      // every error status, whatever the caller makes of it (400: the server could not read the message)
      problem(`${this.url} answered ${body.method ?? "the reply to its request"} with HTTP ${res.status}${text ? `: ${text}` : ""}`);
      const hint = res.status === 401 || res.status === 403 ? " Check the token in the extension's options." : "";
      throw new McpError("http", `HTTP ${res.status}${text ? `: ${text}` : ""}.${hint}`, res.status);
    }
    return { res, done };
  }

  /** Reads an SSE answer until the response with `id` arrives; answers the server's own requests on the way. */
  private async readStream(res: Response, id: number): Promise<JsonRpcMessage | undefined> {
    if (!res.body) return undefined;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        // a timeout or a cancel aborts the fetch, and the read then fails with that McpError
        const { value, done } = await reader.read();
        if (done) return undefined;
        for (const data of parser.push(value)) {
          // an event without data (a server primes the stream for resuming with one): nothing to read
          if (!data.trim()) continue;
          let msg: JsonRpcMessage;
          try {
            msg = JSON.parse(data) as JsonRpcMessage;
          } catch (e) {
            problem(`${this.url} sent an event that is not JSON; it was skipped: ${data.slice(0, 300)}`, e);
            continue;
          }
          if (msg.id === id && (msg.result !== undefined || msg.error)) return msg;
          if (msg.method && msg.id !== undefined && msg.id !== null) void this.answerServerRequest(msg);
        }
      }
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError("network", `The stream broke off (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  /** The client declares no capabilities, so the only request a server may send it is ping. */
  private async answerServerRequest(msg: JsonRpcMessage): Promise<void> {
    const reply: JsonRpcMessage =
      msg.method === "ping"
        ? { jsonrpc: "2.0", id: msg.id, result: {} }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported by this client: ${msg.method}` } };
    try {
      const { res, done } = await this.post(reply, 10_000);
      await res.body?.cancel();
      done();
    } catch (e) {
      // the server will time out its request
      problem(`Could not answer the request "${msg.method}" of ${this.url}.`, e);
    }
  }
}

/** Splits a text/event-stream into the data of its events. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      // a CR at the very end may be the first half of a CRLF split between two chunks
      if (this.buffer[nl] === "\r" && nl === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, nl);
      const sep = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sep);
      if (line === "") {
        if (this.data.length) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
      // event:, id:, retry: and comments do not matter here
    }
    return out;
  }
}

/** Turns a tool result into the text Gemini reads; images and other binary parts become a short note. */
export function resultToText(r: CallToolResult): string {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text") parts.push(c.text ?? "");
    else if (c.type === "image" || c.type === "audio") parts.push(`[${c.type}: ${c.mimeType ?? "unknown type"}, ${approxKb(c.data)} KB, not shown]`);
    else if (c.type === "resource") {
      const res = c.resource ?? {};
      parts.push(res.text !== undefined ? res.text : `[resource ${res.uri ?? ""}${res.mimeType ? ` (${res.mimeType})` : ""}, not shown]`);
    } else if (c.type === "resource_link") parts.push(`[link: ${c.name ?? ""} ${c.uri ?? ""}]`.replace(/\s+\]/, "]"));
    else parts.push(`[${c.type} content]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join("\n");
}

function approxKb(base64: string | undefined): number {
  return Math.max(1, Math.round(((base64?.length ?? 0) * 3) / 4 / 1024));
}
