// The service worker: keeps the connections to the MCP servers, runs the calls the page asks for, and turns the
// bridge on and off per tab. The page script cannot reach 127.0.0.1 itself: the page's own rules apply to it.

import type { BridgeState, CallReply, PerfServer, PortRequest, Request, ServerConfig, ServerState, Settings } from "../shared/config.ts";
import { loadSettings, PERF_LINES_KEY, PERF_SERVER_KEY, updateSettings } from "../shared/config.ts";
import { TEST_BUILD } from "../shared/dom.ts";
import type { ToolInfo } from "../shared/protocol.ts";
import { failed, problem, problemOnce } from "../shared/report.ts";
import { allowSite, own, policiesOn } from "../shared/sites.ts";
import { exposeTools, noSuchTool } from "../shared/tools.ts";
import { McpClient, McpError, resultToText } from "./mcp-client.ts";

interface Conn {
  config: ServerConfig;
  client: McpClient;
  tools: ToolInfo[];
  status: ServerState["status"];
  error?: string;
  listedAt: number;
  pending?: Promise<void>;
  /** When the server answered 404 to the performance log (a version from before it): tried again a minute later. */
  perfMissingAt?: number;
}

const conns = new Map<string, Conn>();
const LIST_MAX_AGE_MS = 30_000;
/** A call names a tool that is not in the lists: they are fetched again only when one is older than this (a page
 * that names made-up tools over and over must not make every server list its tools each time). */
const RELIST_MIN_AGE_MS = 5_000;

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
          c = { config: cfg, client: new McpClient({ url: cfg.url, headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {} }), tools: [], status: "connecting", listedAt: 0 };
          conns.set(cfg.id, c);
        }
        c.config = cfg;
        if (!refresh && c.status === "ok" && Date.now() - c.listedAt < LIST_MAX_AGE_MS) return Promise.resolve();
        return (c.pending ??= list(c));
      }),
  );
}

async function list(c: Conn): Promise<void> {
  try {
    if (!c.client.connected) await c.client.connect();
    c.tools = await c.client.listTools();
    c.status = "ok";
    c.error = undefined;
    c.listedAt = Date.now();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // once per error: the pages ask for the tools again and again
    if (c.status !== "error" || c.error !== error) problem(`MCP server "${c.config.name}" (${c.config.url}): ${error}`, e);
    c.status = "error";
    c.error = error;
    c.tools = [];
    await c.client.close();
  } finally {
    c.pending = undefined;
  }
}

const live = () => [...conns.values()].filter((c) => c.status === "ok");

/** The tools as they are on one site: there an "Auto" tool whose sites miss it is "ask". */
function tools(settings: Settings, site: string) {
  return exposeTools(
    live().map((c) => ({ id: c.config.id, name: c.config.name, tools: c.tools })),
    policiesOn(settings, site),
  );
}

/** The site of the page that sent a message, as Chrome tells it (not as the page says): "" when there is none. */
function siteOf(sender: chrome.runtime.MessageSender | undefined): string {
  try {
    return sender?.origin ?? (sender?.url ? new URL(sender.url).origin : "");
  } catch {
    return "";
  }
}

async function getState(refresh: boolean, site: string): Promise<BridgeState> {
  const settings = await loadSettings();
  await sync(settings, refresh);
  const { visible, hidden } = tools(settings, site);
  const ok = live();
  const notes: string[] = [];
  for (const c of ok) {
    const note = (c.client.info?.instructions ?? "").trim();
    if (note) notes.push(ok.length > 1 ? `${c.config.name}: ${note}` : note);
  }
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
  const { autoSend, maxResultChars } = settings;
  return { enabled: settings.enabled, servers, tools: visible, hiddenTools: hidden, notes, behavior: { autoSend, maxResultChars }, perfLog: settings.perfLog };
}

/**
 * Runs one call. The policy is checked here, from the settings as they are now and the site Chrome says the page
 * is on, whatever the page believed: an "ask" tool (or an "Auto" one on another site) runs only with the user's
 * approval of this call, an "off" or unknown tool never.
 */
async function callTool(name: string, args: Record<string, unknown>, approved: boolean, site: string, signal: AbortSignal): Promise<CallReply> {
  const started = Date.now();
  const reply = (ok: boolean, text: string, needsApproval = false, error?: unknown): CallReply => {
    const r: CallReply = { ok, text, durationMs: Date.now() - started, ...(needsApproval ? { needsApproval } : {}) };
    // the service worker's console (chrome://extensions, "service worker") shows why a call failed
    if (!ok && !needsApproval && !signal.aborted)
      problem(`${name} failed (${r.durationMs} ms): ${text}`, { arguments: args, site, ...(error === undefined ? {} : { error }) });
    return r;
  };
  const settings = await loadSettings();
  if (!settings.enabled) return reply(false, "MCP Bridge is turned off in the browser.");
  await sync(settings, false);
  let exposed = tools(settings, site);
  let tool = exposed.visible.find((t) => t.name === name);
  if (!tool && !exposed.hidden.some((t) => t.name === name) && live().some((c) => Date.now() - c.listedAt > RELIST_MIN_AGE_MS)) {
    // perhaps a server got the tool since the list was made
    await sync(settings, true);
    exposed = tools(settings, site);
    tool = exposed.visible.find((t) => t.name === name);
  }
  if (!tool) return reply(false, noSuchTool(name, exposed.visible.map((t) => t.name)));
  // the settings as they are now: they may have changed while the servers listed their tools (a site taken out,
  // the tool set to Ask or Off)
  const policy = own(policiesOn(await loadSettings(), site), name) ?? "ask";
  if (policy === "off") return reply(false, noSuchTool(name, exposed.visible.filter((t) => t.name !== name).map((t) => t.name)));
  if (policy !== "auto" && !approved) return reply(false, "This tool needs the user's approval.", true);
  const c = conns.get(tool.serverId);
  if (!c) return reply(false, `The server of ${name} is not connected.`);
  // the page may have gone while the lists were fetched
  if (signal.aborted) return reply(false, "Cancelled.");
  try {
    const r = await c.client.callTool(tool.original, args, settings.callTimeoutSec * 1000, signal);
    return reply(!r.isError, resultToText(r));
  } catch (e) {
    if (e instanceof McpError && (e.kind === "network" || e.kind === "http")) c.status = "error";
    return reply(false, e instanceof Error ? e.message : String(e), false, e);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The performance log (content/perf.ts): its last lines stay in chrome.storage.session for the options page, and
// gemini-mcp-bridge-server gets them for its perf.log. Other MCP servers get nothing of it.

const BRIDGE_SERVER = "gemini-mcp-bridge-server";
const PERF_MAX_CHARS = 100_000;
const PERF_MAX_LINES = 50;
const PERF_MAX_LINE = 2000;
const PERF_RETRY_MS = 60_000;
/** Lines that wait for the server at most; older ones are kept in the browser only. */
const PERF_MAX_WAITING = 500;
/** One batch after the other: two tabs must not overwrite each other's lines. */
let perfQueue: Promise<void> = Promise.resolve();
/** Lines for the server, and whether a post is under way (a server that does not answer must not hold the
 * lines of the options page, or pile up posts). */
let perfWaiting: string[] = [];
let perfPosting = false;

function takePerf(lines: unknown): void {
  if (!Array.isArray(lines)) return;
  const clean = lines
    .filter((l): l is string => typeof l === "string")
    .slice(0, PERF_MAX_LINES)
    .map((l) => l.replace(/[\r\n]+/g, " ").slice(0, PERF_MAX_LINE));
  if (!clean.length) return;
  perfQueue = perfQueue.then(() => keepPerf(clean)).catch(failed("Could not keep the performance log."));
}

async function keepPerf(lines: string[]): Promise<void> {
  const settings = await loadSettings();
  if (!settings.perfLog) return;
  const all = [...(((await chrome.storage.session.get(PERF_LINES_KEY))[PERF_LINES_KEY] as string[] | undefined) ?? []), ...lines];
  let chars = all.reduce((n, l) => n + l.length + 1, 0);
  let drop = 0;
  while (chars > PERF_MAX_CHARS) chars -= all[drop++].length + 1;
  await chrome.storage.session.set({ [PERF_LINES_KEY]: all.slice(drop) });
  perfWaiting.push(...lines);
  if (perfWaiting.length > PERF_MAX_WAITING) perfWaiting = perfWaiting.slice(-PERF_MAX_WAITING);
  if (!perfPosting) void postWaiting(settings);
}

/** Posts what waits, and what came meanwhile; lines the server did not take stay in the browser only. */
async function postWaiting(settings: Settings): Promise<void> {
  perfPosting = true;
  try {
    while (perfWaiting.length) {
      const lines = perfWaiting;
      perfWaiting = [];
      const server = await sendPerf(settings, lines);
      await chrome.storage.session.set({ [PERF_SERVER_KEY]: server });
      if (!server.ok) {
        if (server.why === "error") problemOnce(`The server did not take the performance log: ${server.error ?? "error"}`);
        break;
      }
    }
  } catch (e) {
    problem("Could not pass on the performance log.", e);
  } finally {
    perfPosting = false;
  }
}

/** The options page's Clear: in the queue, so that a batch being kept does not bring the old lines back. */
function clearPerf(): Promise<void> {
  perfQueue = perfQueue.then(() => chrome.storage.session.remove(PERF_LINES_KEY)).catch(failed("Could not clear the performance log."));
  return perfQueue;
}

async function sendPerf(settings: Settings, lines: string[]): Promise<PerfServer> {
  // a service worker that started anew has no connection yet: it connects (and does not list the tools again
  // for each batch after that)
  if (!conns.size) await sync(settings, false);
  let status: PerfServer = { ok: false, why: "none" };
  for (const c of live()) {
    if (c.client.info?.serverInfo?.name !== BRIDGE_SERVER) continue;
    const got = await postPerf(c, lines);
    if (!status.ok) status = got;
  }
  return status;
}

async function postPerf(c: Conn, lines: string[]): Promise<PerfServer> {
  if (c.perfMissingAt && Date.now() - c.perfMissingAt < PERF_RETRY_MS) return { ok: false, why: "old" };
  try {
    const res = await fetch(new URL("perf", c.config.url), {
      method: "POST",
      headers: { ...(c.config.token ? { authorization: `Bearer ${c.config.token}` } : {}), "content-type": "text/plain; charset=utf-8" },
      body: `${lines.join("\n")}\n`,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { ok: true, file: (await res.text()).trim().slice(0, 500) };
    await res.body?.cancel();
    if (res.status !== 404) return { ok: false, why: "error", error: `HTTP ${res.status}` };
    c.perfMissingAt = Date.now();
    return { ok: false, why: "old" };
  } catch (e) {
    return { ok: false, why: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Turning the bridge on and off per tab. A click on the extension's icon gives the extension that one tab
// (activeTab), and the page script goes in there; another click takes it out. The tab stays on through
// reloads on the same site; another site, or closing the tab, ends it.

const ACTIVE_KEY = "activeTabs";

/** Tabs with the bridge on, and the site (origin) it was turned on for. */
async function activeTabs(): Promise<Record<string, string>> {
  return ((await chrome.storage.session.get(ACTIVE_KEY))[ACTIVE_KEY] as Record<string, string> | undefined) ?? {};
}

async function mark(tabId: number, origin: string | null): Promise<void> {
  const tabs = await activeTabs();
  if (origin) tabs[tabId] = origin;
  else delete tabs[tabId];
  await chrome.storage.session.set({ [ACTIVE_KEY]: tabs });
  await chrome.action.setBadgeText({ tabId, text: origin ? "ON" : "" }).catch(() => undefined);
  if (origin) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#188038" }).catch(() => undefined);
}

/** The page script is running in the tab. */
async function running(tabId: number): Promise<boolean> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "ping" })) === "pong";
  } catch {
    return false;
  }
}

/** Puts the page script into the tab, when the tab shows `origin` (any site when not given); returns the site, or
 * null when the tab shows another one. */
async function inject(tabId: number, origin?: string): Promise<string | null> {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.origin });
  const site = String(r?.result ?? "");
  if (origin !== undefined && site !== origin) return null;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return site;
}

async function turnOff(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: "deactivate" }).catch(() => undefined);
  await mark(tabId, null);
}

/** On where it is off, off where it is on; returns the new state. */
async function toggleTab(tabId: number): Promise<boolean> {
  if (await running(tabId)) {
    await turnOff(tabId);
    return false;
  }
  await mark(tabId, await inject(tabId));
  return true;
}

// the tests turn tabs on this way (they cannot click the toolbar)
if (TEST_BUILD) (globalThis as { gmbToggleTab?: typeof toggleTab }).gmbToggleTab = toggleTab;

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void toggleTab(tab.id).catch(failed(`Could not turn the bridge on or off in the tab ${tab.url ?? tab.id}.`));
});

// a page that loaded anew has lost the script: on the same site it goes in again
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  void (async () => {
    const origin = (await activeTabs())[tabId];
    if (!origin) return;
    if (await running(tabId)) {
      // the page changed its address only (a chat app does that): the script is still there
      await chrome.action.setBadgeText({ tabId, text: "ON" }).catch(() => undefined);
      return;
    }
    try {
      await mark(tabId, await inject(tabId, origin));
    } catch (e) {
      problem(`Could not start the bridge again after the tab loaded anew (${origin}): it is off there now.`, e);
      await mark(tabId, null);
    }
  })().catch(failed("Could not start the bridge again after a tab loaded anew."));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void activeTabs().then((tabs) => {
    if (!(tabId in tabs)) return;
    delete tabs[tabId];
    return chrome.storage.session.set({ [ACTIVE_KEY]: tabs });
  }).catch(failed("Could not forget a closed tab."));
});

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  if (msg.type === "turnOff") {
    if (sender.tab?.id !== undefined) void turnOff(sender.tab.id).catch(failed("Could not turn the bridge off in the tab."));
    return false;
  }
  if (msg.type === "getState") {
    getState(msg.refresh === true, siteOf(sender)).then(sendResponse, (e: unknown) => {
      problem("Could not list the tools.", e);
      sendResponse({ error: String(e) });
    });
    return true;
  }
  if (msg.type === "allowHere") {
    const site = siteOf(sender);
    if (!/^https?:\/\//.test(site) || typeof msg.tool !== "string") {
      problem(`"Always allow here" came from a page that is not a web site (${site || "none"}): not kept.`);
      sendResponse(false);
      return false;
    }
    updateSettings((s) => allowSite(s, msg.tool, site)).then(
      () => sendResponse(true),
      (e: unknown) => {
        problem(`Could not keep "Always allow here" for ${msg.tool} on ${site}.`, e);
        sendResponse(false);
      },
    );
    return true;
  }
  // the extension's own pages (the options page, also when it is open in a tab) and the page scripts
  const ownPage = sender.url?.startsWith(chrome.runtime.getURL("")) === true;
  if (msg.type === "perf") {
    if (sender.tab && !ownPage) takePerf(msg.lines);
    return false;
  }
  if (msg.type === "perfClear") {
    if (!ownPage) return false;
    void clearPerf().then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "openOptions") void chrome.runtime.openOptionsPage().catch(failed("Could not open the options page."));
  return false;
});

// A call goes over a port: the page pings it while the call runs (each message keeps this worker alive for long
// calls), and closing the tab aborts the call.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "call") return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener((msg: PortRequest) => {
    if (msg.type !== "call") return;
    const send = (r: CallReply) => {
      try {
        port.postMessage(r);
      } catch (e) {
        problem(`The result of ${msg.tool} could not be passed to the page (it went away).`, e);
      }
    };
    callTool(msg.tool, msg.arguments ?? {}, msg.approved === true, siteOf(port.sender), ctrl.signal).then(send, (e: unknown) => {
      problem(`${msg.tool} failed in the extension.`, e);
      send({ ok: false, text: `The extension failed: ${String(e)}`, durationMs: 0 });
    });
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage().catch(failed("Could not open the options page."));
});
