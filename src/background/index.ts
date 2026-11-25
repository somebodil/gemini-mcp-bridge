// The service worker: keeps the connections to the MCP servers and runs the calls the page asks for.
// The page (content script) cannot reach 127.0.0.1 itself: Gemini's page rules apply to it.

import type { BridgeState, ExposedTool, PortReply, PortRequest, Request, ServerConfig, ServerState, Settings } from "../shared/config.ts";
import { loadSettings, noSuchTool, saveSettings } from "../shared/config.ts";
import type { ToolInfo } from "../shared/protocol.ts";
import { McpClient, McpError, resultToText } from "./mcp-client.ts";

interface Conn {
  config: ServerConfig;
  client: McpClient;
  tools: ToolInfo[];
  status: ServerState["status"];
  error?: string;
  listedAt: number;
  pending?: Promise<void>;
}

const conns = new Map<string, Conn>();
const LIST_MAX_AGE_MS = 30_000;

const identity = (c: ServerConfig) => JSON.stringify([c.url, c.token]);

/** Connects the enabled servers, drops the removed ones, and lists tools again when the list is old. */
async function sync(settings: Settings, refresh: boolean): Promise<void> {
  for (const [id, c] of conns) {
    const cfg = settings.servers.find((s) => s.id === id);
    if (!cfg || !cfg.enabled || !settings.enabled || identity(cfg) !== identity(c.config)) {
      void c.client.close();
      conns.delete(id);
    }
  }
  if (!settings.enabled) return;
  await Promise.all(
    settings.servers
      .filter((s) => s.enabled)
      .map((cfg) => {
        let c = conns.get(cfg.id);
        if (!c) {
          c = { config: cfg, client: newClient(cfg), tools: [], status: "connecting", listedAt: 0 };
          conns.set(cfg.id, c);
        }
        c.config = cfg;
        if (!refresh && c.status === "ok" && Date.now() - c.listedAt < LIST_MAX_AGE_MS) return Promise.resolve();
        return (c.pending ??= list(c));
      }),
  );
}

function newClient(cfg: ServerConfig): McpClient {
  return new McpClient({ url: cfg.url, headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {} });
}

async function list(c: Conn): Promise<void> {
  try {
    if (!c.client.connected) await c.client.connect();
    c.tools = await c.client.listTools();
    c.status = "ok";
    c.error = undefined;
    c.listedAt = Date.now();
  } catch (e) {
    c.status = "error";
    c.error = e instanceof Error ? e.message : String(e);
    c.tools = [];
    await c.client.close();
  } finally {
    c.pending = undefined;
  }
}

/** Tool names as Gemini sees them: the server's own name, prefixed with the server only when two servers share it. */
function expose(settings: Settings): { visible: ExposedTool[]; hidden: ExposedTool[] } {
  const live = [...conns.values()].filter((c) => c.status === "ok");
  const count = new Map<string, number>();
  for (const c of live) for (const t of c.tools) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  const visible: ExposedTool[] = [];
  const hidden: ExposedTool[] = [];
  for (const c of live) {
    for (const t of c.tools) {
      const name = (count.get(t.name) ?? 0) > 1 ? `${c.config.name}__${t.name}` : t.name;
      const set = settings.policies[name];
      const tool: ExposedTool = { ...t, name, original: t.name, serverId: c.config.id, policy: set === "off" ? "off" : settings.autoRunAll ? "auto" : (set ?? "ask") };
      (tool.policy === "off" ? hidden : visible).push(tool);
    }
  }
  return { visible, hidden };
}

async function getState(refresh: boolean): Promise<BridgeState> {
  const settings = await loadSettings();
  await sync(settings, refresh);
  const { visible, hidden } = expose(settings);
  const live = [...conns.values()].filter((c) => c.status === "ok");
  const notes = live
    .map((c) => (c.client.info?.instructions ?? "").trim() && (live.length > 1 ? `${c.config.name}: ` : "") + (c.client.info?.instructions ?? "").trim())
    .filter(Boolean);
  const servers: ServerState[] = settings.servers.map((cfg) => {
    const c = conns.get(cfg.id);
    return {
      id: cfg.id,
      name: cfg.name,
      url: cfg.url,
      status: !settings.enabled || !cfg.enabled ? "off" : (c?.status ?? "connecting"),
      error: c?.error,
      toolCount: c?.tools.length ?? 0,
      serverName: c?.client.info?.serverInfo?.name,
    };
  });
  const forPage: Settings = { ...settings, servers: settings.servers.map((s) => ({ ...s, token: s.token ? "(set)" : "" })) };
  return { enabled: settings.enabled, servers, tools: visible, hiddenTools: hidden, notes, settings: forPage };
}

/**
 * Runs one call. The policy is checked here, from the settings as they are now, whatever the page believed:
 * an "ask" tool runs only with the user's approval of this call, an "off" or unknown tool never.
 */
async function callTool(name: string, args: Record<string, unknown>, approved: boolean, signal: AbortSignal): Promise<PortReply> {
  const started = Date.now();
  const reply = (ok: boolean, text: string, needsApproval = false): PortReply => ({ type: "result", ok, text, durationMs: Date.now() - started, ...(needsApproval ? { needsApproval } : {}) });
  const settings = await loadSettings();
  if (!settings.enabled) return reply(false, "MCP Bridge is turned off in the browser.");
  let state = await getState(false);
  let tool = state.tools.find((t) => t.name === name);
  if (!tool && !state.hiddenTools.some((t) => t.name === name)) {
    state = await getState(true);
    tool = state.tools.find((t) => t.name === name);
  }
  if (!tool) return reply(false, noSuchTool(name, state.tools.map((t) => t.name)));
  if (tool.policy !== "auto" && !approved) return reply(false, "This tool needs the user's approval.", true);
  const c = conns.get(tool.serverId);
  if (!c) return reply(false, `The server of ${name} is not connected.`);
  // the page may have gone while the lists were fetched
  if (signal.aborted) return reply(false, "Cancelled.");
  try {
    const r = await c.client.callTool(tool.original, args, settings.callTimeoutSec * 1000, signal);
    return reply(!r.isError, resultToText(r));
  } catch (e) {
    if (e instanceof McpError && (e.kind === "network" || e.kind === "http")) c.status = "error";
    return reply(false, e instanceof Error ? e.message : String(e));
  }
}

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  if (msg.type === "getState") {
    getState(msg.refresh === true).then(sendResponse, (e: unknown) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "setPolicy") {
    void (async () => {
      const s = await loadSettings();
      s.policies[msg.tool] = msg.policy;
      await saveSettings(s);
      sendResponse(true);
    })();
    return true;
  }
  if (msg.type === "openOptions") {
    void chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

// A call goes over a port: the page pings it while the call runs, which keeps this worker alive for long calls,
// and closing the tab aborts the call.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "call") return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener((msg: PortRequest) => {
    if (msg.type === "ping") {
      port.postMessage({ type: "pong" } satisfies PortReply);
      return;
    }
    if (msg.type === "call") {
      void callTool(msg.tool, msg.arguments ?? {}, msg.approved === true, ctrl.signal).then((r) => {
        try {
          port.postMessage(r);
        } catch {
          // the page went away
        }
      });
    }
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});
