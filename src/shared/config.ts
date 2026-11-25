// Settings kept in chrome.storage.local, and the messages between the page and the service worker.

import type { ToolInfo } from "./protocol.ts";

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
  /** Results sent by the extension in a row, without a message of the user, before it pauses. */
  maxRounds: number;
  /** Characters of tool output per results message. */
  maxResultChars: number;
}

export interface Settings extends Behavior {
  enabled: boolean;
  servers: ServerConfig[];
  /** Per exposed tool name. A tool without an entry is asked about. */
  policies: Record<string, Policy>;
  callTimeoutSec: number;
}

export const DEFAULT_URL = "http://127.0.0.1:7341/mcp";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  servers: [{ id: "local", name: "local", url: DEFAULT_URL, token: "", enabled: true }],
  policies: {},
  autoSend: true,
  maxRounds: 20,
  maxResultChars: 20000,
  callTimeoutSec: 300,
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const got = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return normalizeSettings(got);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: normalizeSettings(s) });
}

/** Applies one change to the settings as they are stored now (others may have changed them meanwhile). */
export async function updateSettings(change: (s: Settings) => void): Promise<Settings> {
  const fresh = await loadSettings();
  change(fresh);
  await saveSettings(fresh);
  return normalizeSettings(fresh);
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
    autoSend: s.autoSend !== false,
    maxRounds: num(s.maxRounds, DEFAULT_SETTINGS.maxRounds, 1, 200),
    maxResultChars: num(s.maxResultChars, DEFAULT_SETTINGS.maxResultChars, 1000, 200000),
    callTimeoutSec: num(s.callTimeoutSec, DEFAULT_SETTINGS.callTimeoutSec, 5, 3600),
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
}

export type Request = { type: "getState"; refresh?: boolean } | { type: "setPolicy"; tool: string; policy: Policy } | { type: "openOptions" };

/** `approved`: the user pressed Run for this very call. The service worker runs an "ask" tool only then. */
export type PortRequest = { type: "call"; tool: string; arguments: Record<string, unknown>; approved: boolean } | { type: "ping" };

/** The answer to a call. `needsApproval`: the tool is "ask" (the page's list was out of date); nothing ran. */
export interface CallReply {
  ok: boolean;
  text: string;
  durationMs: number;
  needsApproval?: boolean;
}
