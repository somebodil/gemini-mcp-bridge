// Where what the extension learned about chat pages is kept: chrome.storage.local under "layouts", one layout per
// site (its origin). The content script reads and writes its own site's (content/layout.ts); the options page
// lists them all and deletes them.

// How a layout is kept is told in content/layout.ts.

export type Role = "input" | "send" | "busy" | "list" | "mine" | "reply" | "code";
export const ROLES: readonly Role[] = ["input", "send", "busy", "list", "mine", "reply", "code"];

/** One element: a selector per tree, from the document down through the shadow roots that hold it. */
export type Locator = string[];
/** Elements of one kind: a selector each of them matches, looked for through shadow roots. */
export type Pattern = string;

/** Which AI answers on a site, as it said itself in its reply to the test message. */
export type Ai = "claude" | "chatgpt" | "gemini" | "other";

/** The AI a reply named: the three by their names or makers, any other name "other"; undefined when it named none. */
export function aiNamed(said: string | undefined): Ai | undefined {
  const s = (said ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (/claude|anthropic/.test(s)) return "claude";
  if (/gpt|openai|codex/.test(s)) return "chatgpt";
  if (/gemini|google/.test(s)) return "gemini";
  return "other";
}

export interface Layout {
  v: 1;
  /** When it was learned (or last changed by hand). */
  at: number;
  input?: Locator;
  send?: Locator;
  /**
   * What tells that the page is writing a reply: the element there looks like `look` (learned while the page
   * wrote), or (picked by hand while it did not write) its name is no longer `idle`.
   */
  busy?: { at: Locator; look?: string; idle?: string };
  list?: Locator;
  /** The page sends with Ctrl+Enter (Cmd+Enter): Enter alone makes a new line there. */
  sendKey?: "mod";
  mine?: Pattern;
  reply?: Pattern;
  code?: Pattern;
  /** Roles the user picked by hand. */
  picked?: Role[];
  /** Which AI answers here: the instructions tell it its own folder on the user's computer. */
  ai?: Ai;
}

export const LAYOUTS_KEY = "layouts";

export async function loadLayouts(): Promise<Record<string, Layout>> {
  const all = ((await chrome.storage.local.get(LAYOUTS_KEY))[LAYOUTS_KEY] ?? {}) as Record<string, Layout>;
  return Object.fromEntries(Object.entries(all).filter(([, l]) => l?.v === 1));
}

export async function storeLayout(site: string, layout: Layout | null): Promise<void> {
  const all = ((await chrome.storage.local.get(LAYOUTS_KEY))[LAYOUTS_KEY] ?? {}) as Record<string, Layout>;
  if (layout) all[site] = layout;
  else delete all[site];
  await chrome.storage.local.set({ [LAYOUTS_KEY]: all });
}
