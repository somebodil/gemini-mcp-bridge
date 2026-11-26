// Settings kept in chrome.storage.local, and the messages between the page and the service worker.

import type { ToolInfo } from "./protocol.ts";
import { GEMINI_SITE } from "./sites.ts";

export type Policy = "ask" | "auto" | "off";

export interface ServerConfig {
  id: string;
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer <token>` when not empty. */
  token: string;
  enabled: boolean;
}

/** What the page of Gemini needs of the settings. */
export interface Behavior {
  /** Send the results to Gemini by itself; off: the results wait in the input box for the user to send. */
  autoSend: boolean;
  /** Characters of tool output per results message. */
  maxResultChars: number;
}

export interface Settings extends Behavior {
  enabled: boolean;
  servers: ServerConfig[];
  /** Per exposed tool name. A tool without an entry is asked about. */
  policies: Record<string, Policy>;
  /** Per "Auto" tool: the sites where it runs without asking (regular expressions of whole site addresses, sites.ts). */
  autoSites: Record<string, string[]>;
  callTimeoutSec: number;
  /** The performance log (content/perf.ts): off unless the user turns it on. */
  perfLog: boolean;
}

export const DEFAULT_URL = "http://127.0.0.1:7341/mcp";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  servers: [{ id: "local", name: "local", url: DEFAULT_URL, token: "", enabled: true }],
  policies: {},
  autoSites: {},
  autoSend: true,
  maxResultChars: 20000,
  callTimeoutSec: 300,
  perfLog: false,
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const got = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return normalizeSettings(got);
}

/** Applies one change to the settings as they are stored now (others may have changed them meanwhile). */
export async function updateSettings(change: (s: Settings) => void): Promise<Settings> {
  const fresh = await loadSettings();
  change(fresh);
  const s = normalizeSettings(fresh);
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

const POLICIES = new Set<unknown>(["ask", "auto", "off"]);

export function normalizeSettings(got: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(got ?? {}) };
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
  const policies: Record<string, Policy> = {};
  if (typeof s.policies === "object" && s.policies) for (const [k, v] of Object.entries(s.policies)) if (POLICIES.has(v)) policies[k] = v;
  // only "Auto" tools have sites: one set to Ask or Off forgets them. An "Auto" without a list (stored before there
  // were sites, or just chosen on the options page) is Gemini's; an emptied list stays empty
  const autoSites: Record<string, string[]> = {};
  const lists = typeof s.autoSites === "object" && s.autoSites ? (s.autoSites as Record<string, unknown>) : {};
  for (const [k, p] of Object.entries(policies)) {
    if (p !== "auto" || k === "__proto__") continue;
    const v = Object.hasOwn(lists, k) ? lists[k] : undefined;
    autoSites[k] = Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))] : [GEMINI_SITE];
  }
  return {
    enabled: s.enabled !== false,
    servers: Array.isArray(s.servers)
      ? s.servers
          .filter((x) => x && typeof x.url === "string")
          .map((x, i) => ({
            id: typeof x.id === "string" && x.id ? x.id : `s${i}`,
            name: typeof x.name === "string" && x.name.trim() ? x.name.trim() : `server${i + 1}`,
            url: x.url.trim(),
            token: typeof x.token === "string" ? x.token.trim() : "",
            enabled: x.enabled !== false,
          }))
      : DEFAULT_SETTINGS.servers,
    policies,
    autoSites,
    autoSend: s.autoSend !== false,
    maxResultChars: num(s.maxResultChars, DEFAULT_SETTINGS.maxResultChars, 1000, 200000),
    callTimeoutSec: num(s.callTimeoutSec, DEFAULT_SETTINGS.callTimeoutSec, 5, 3600),
    perfLog: s.perfLog === true,
  };
}

/** The extension asks only for 127.0.0.1 and localhost: these are the URLs it can reach. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// State the service worker reports

export interface ServerState {
  id: string;
  name: string;
  url: string;
  status: "off" | "connecting" | "ok" | "error";
  error?: string;
  toolCount: number;
  serverName?: string;
}

export interface ExposedTool extends ToolInfo {
  /** Name of the tool on its server (the exposed name differs only when two servers have the same tool). */
  original: string;
  serverId: string;
  policy: Policy;
}

export interface BridgeState {
  enabled: boolean;
  servers: ServerState[];
  /** Tools Gemini is told about: those not turned off. */
  tools: ExposedTool[];
  /** Tools turned off in the options, listed there so that they can be turned on again. */
  hiddenTools: ExposedTool[];
  notes: string[];
  behavior: Behavior;
  perfLog: boolean;
}

export type Request =
  | { type: "getState"; refresh?: boolean }
  /** "Always allow" on a card: the tool runs without asking on the site of the page that sent this, from now on. */
  | { type: "allowHere"; tool: string }
  | { type: "openOptions" }
  /** From the page script: turn the bridge off in its own tab. */
  | { type: "turnOff" }
  /** From the page script: lines of the performance log. */
  | { type: "perf"; lines: string[] }
  /** From the options page: forget the lines of the performance log. */
  | { type: "perfClear" };

/** The performance log in chrome.storage.session: its last lines, and whether the server took them. */
export const PERF_LINES_KEY = "perfLines";
export const PERF_SERVER_KEY = "perfServer";
export type PerfServer = { ok: true; file: string } | { ok: false; why: "none" | "old" | "error"; error?: string };

/** `approved`: the user pressed Run for this very call. The service worker runs an "ask" tool only then. */
export type PortRequest = { type: "call"; tool: string; arguments: Record<string, unknown>; approved: boolean } | { type: "ping" };

/** The answer to a call. `needsApproval`: the tool is "ask" (the page's list was out of date); nothing ran. */
export interface CallReply {
  ok: boolean;
  text: string;
  durationMs: number;
  needsApproval?: boolean;
}
