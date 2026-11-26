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
  /** The sites where the "Auto" tools run without asking, one list for all of them (regular expressions of whole
   * site addresses, sites.ts). */
  autoSites: string[];
  callTimeoutSec: number;
  /** The performance log (content/perf.ts): off unless the user turns it on. */
  perfLog: boolean;
}

export const DEFAULT_URL = "http://127.0.0.1:7341/mcp";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  servers: [{ id: "local", name: "local", url: DEFAULT_URL, token: "", enabled: true }],
  policies: {},
  autoSites: [GEMINI_SITE],
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
    autoSites: siteList(s.autoSites, policies),
    autoSend: s.autoSend !== false,
    maxResultChars: num(s.maxResultChars, DEFAULT_SETTINGS.maxResultChars, 1000, 200000),
    callTimeoutSec: num(s.callTimeoutSec, DEFAULT_SETTINGS.callTimeoutSec, 5, 3600),
    perfLog: s.perfLog === true,
  };
}

/**
 * The sites of the "Auto" tools, without blanks or repeats; an emptied list stays empty. Kept per tool (0.4.0 and
 * before), they become one list of the sites of every "Auto" tool, where one without a list there (stored before
 * there were sites) ran on Gemini.
 */
function siteList(v: unknown, policies: Record<string, Policy>): string[] {
  const clean = (l: unknown) => (Array.isArray(l) ? l.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [GEMINI_SITE]);
  if (Array.isArray(v)) return [...new Set(clean(v))];
  if (typeof v !== "object" || !v) return [GEMINI_SITE];
  const perTool = v as Record<string, unknown>;
  const auto = Object.keys(policies).filter((k) => policies[k] === "auto");
  return auto.length ? [...new Set(auto.flatMap((k) => clean(Object.hasOwn(perTool, k) ? perTool[k] : undefined)))] : [GEMINI_SITE];
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
