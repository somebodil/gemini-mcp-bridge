// What the extension draws on Gemini's page: a card under each tool call, a status button in the corner, and
// chips that stand in for the instruction and result messages. Cards and the button live in shadow roots so
// that Gemini's styles do not reach them; nothing is built from HTML strings.

import type { BridgeState } from "../shared/config.ts";
import { h, onTrustedClick } from "../shared/dom.ts";
import { t } from "../shared/i18n.ts";
import type { ParsedCall, ParseProblem } from "../shared/protocol.ts";

/** The buttons of a new question stay disabled this long: a key pressed while typing does not answer it. */
const ASK_GUARD_MS = 600;

/** Characters that change how text is shown without being seen (bidi controls, zero-width) are shown as \u{...}. */
function visible(s: string): string {
  return s.replace(/[​-‏‪-‮⁠-⁩﻿]/g, (c) => `\\u{${c.codePointAt(0)?.toString(16).toUpperCase()}}`);
}

/** Dark when the page's background is dark: Gemini follows its own theme setting, not only the system's. */
export function pageIsDark(): boolean {
  for (const el of [document.body, document.documentElement]) {
    const m = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g);
    if (m && m.length >= 3 && (m.length < 4 || Number(m[3]) > 0)) {
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    }
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

const BASE_CSS = `
:host { all: initial; display: block; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
  --fg: #1f1f1f; --muted: #5f6368; --bg: #f8f9fa; --line: #dadce0; --accent: #0b57d0; --accent-fg: #fff;
  --ok: #188038; --err: #c5221f; --warn: #b06000; color: var(--fg); }
:host([data-dark]) { --fg: #e3e3e3; --muted: #9aa0a6; --bg: #1e1f20; --line: #3c4043; --accent: #a8c7fa; --accent-fg: #062e6f;
  --ok: #81c995; --err: #f28b82; --warn: #fdd663; }
button { font: inherit; cursor: pointer; border-radius: 999px; padding: 4px 12px; border: 1px solid var(--line);
  background: transparent; color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
pre { margin: 4px 0 0; padding: 8px; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(127,127,127,.12); border-radius: 6px; }
details > summary { cursor: pointer; color: var(--muted); margin-top: 4px; }
.ok { color: var(--ok); } .err { color: var(--err); } .warn { color: var(--warn); } .muted { color: var(--muted); }
`;

/** One stylesheet object for all cards (and one for the button): not a <style> in each shadow root. */
function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// Cards

export type RowState = "waiting" | "ask" | "running" | "done" | "error" | "denied" | "earlier" | "skipped" | "unreadable";
type Decision = "run" | "always" | "deny";

const CARD_SHEET = sheet(`${BASE_CSS}
.card { margin: 8px 0; border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; background: var(--bg); }
.row + .row { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 8px; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tool { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.state { margin-left: auto; }
.ask { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%;
  animation: spin 0.8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
`);

export class Row {
  readonly el: HTMLDivElement;
  private readonly stateEl: HTMLSpanElement;
  private readonly body: HTMLDivElement;
  private readonly argsText: string;

  constructor(tool: string, args: unknown) {
    this.argsText = args === undefined ? "" : visible(JSON.stringify(args, null, 2));
    this.stateEl = h("span", { class: "state" });
    this.body = h("div");
    this.el = h("div", { class: "row" }, h("div", { class: "head" }, h("span", {}, "🔧"), h("span", { class: "tool" }, tool), this.stateEl), this.body);
  }

  set(state: RowState, detail: { output?: string; durationMs?: number; note?: string } = {}): void {
    const labels: Record<RowState, [string, string]> = {
      waiting: [t("stateWaiting"), "muted"],
      ask: [t("askCall"), "warn"],
      running: [t("stateRunning"), "muted"],
      done: [t("stateDone"), "ok"],
      error: [t("stateError"), "err"],
      denied: [t("stateDenied"), "muted"],
      earlier: [t("stateEarlier"), "muted"],
      skipped: [t("stateSkipped"), "muted"],
      unreadable: [t("stateUnreadable"), "err"],
    };
    const [label, cls] = labels[state];
    const time = detail.durationMs !== undefined ? ` · ${(detail.durationMs / 1000).toFixed(1)} s` : "";
    this.stateEl.className = `state ${cls}`;
    this.stateEl.replaceChildren(state === "running" ? h("span", { class: "spin" }) : "", ` ${label}${time}`);
    const parts: Node[] = [];
    if (this.argsText && this.argsText !== "{}") parts.push(this.details(t("args"), this.argsText, state === "ask"));
    if (detail.note) parts.push(h("div", { class: "muted" }, visible(detail.note)));
    if (detail.output !== undefined) {
      const out = visible(detail.output.length > 4000 ? `${detail.output.slice(0, 4000)}\n...` : detail.output || "(no output)");
      parts.push(this.details(t("output"), out, false));
    }
    this.body.replaceChildren(...parts);
  }

  /**
   * Shows Run / Always allow / Deny and waits for a real click on one. Nothing takes the focus, and the buttons
   * wake up only after a moment. An aborted signal (the user left the chat) answers "deny".
   */
  ask(signal?: AbortSignal): Promise<Decision> {
    this.set("ask");
    return new Promise((resolve) => {
      let done = false;
      const finish = (d: Decision) => {
        if (done) return;
        done = true;
        clearTimeout(wake);
        signal?.removeEventListener("abort", onAbort);
        bar.remove();
        resolve(d);
      };
      const onAbort = () => finish("deny");
      const run = h("button", { class: "primary", disabled: "" }, t("run"));
      const always = h("button", { disabled: "" }, t("alwaysAllow"));
      const deny = h("button", { disabled: "" }, t("deny"));
      onTrustedClick(run, () => finish("run"));
      onTrustedClick(always, () => finish("always"));
      onTrustedClick(deny, () => finish("deny"));
      const bar = h("div", { class: "ask" }, run, always, deny);
      this.body.append(bar);
      const wake = setTimeout(() => {
        for (const b of [run, always, deny]) b.disabled = false;
      }, ASK_GUARD_MS);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private details(title: string, text: string, open: boolean): HTMLDetailsElement {
    const d = h("details", {}, h("summary", {}, title), h("pre", {}, text));
    d.open = open;
    return d;
  }
}

let dark = false;
const allCards = new Set<Card>();

/** The page's theme, read once per tick; cards and the button follow it. */
export function setTheme(isDark: boolean): void {
  if (isDark === dark) return;
  dark = isDark;
  for (const c of allCards) c.host.toggleAttribute("data-dark", dark);
}

export class Card {
  readonly host: HTMLElement;
  private readonly box: HTMLDivElement;
  rows: Row[] = [];
  /** "live" once the extension handles the calls of this card, "earlier" for calls from before. */
  mode: "earlier" | "waiting" | "live" = "earlier";
  /** The block text the rows were made from: a block still being written is parsed again when it grows. */
  text = "";

  constructor() {
    this.host = document.createElement("gmb-card");
    const root = this.host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [CARD_SHEET];
    this.box = h("div", { class: "card" });
    root.append(this.box);
    this.host.toggleAttribute("data-dark", dark);
    allCards.add(this);
  }

  /** One row per call, and one per block that could not be read (with the reason). */
  setCalls(calls: ParsedCall[], problems: ParseProblem[], state: RowState): Row[] {
    this.rows = calls.map((c) => new Row(c.tool, c.arguments));
    for (const r of this.rows) r.set(state);
    const bad = problems.map((p) => {
      const r = new Row("mcp_call", undefined);
      r.set("unreadable", { note: p.error });
      return r;
    });
    this.box.replaceChildren(...this.rows.map((r) => r.el), ...bad.map((r) => r.el));
    return this.rows;
  }

  /** Leaves the page for good (another conversation was opened). */
  drop(): void {
    allCards.delete(this);
    this.host.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Status button and its panel

export interface Notice {
  kind: "paused" | "results" | "inBox" | "sendFailed";
  text: string;
  action?: { label: string; run: () => void };
}

export interface PillHandlers {
  onToggleChat(on: boolean): void;
  onRefresh(): void;
  onSettings(): void;
}

const PILL_SHEET = sheet(`${BASE_CSS}
:host { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; }
.pill { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.ok { background: var(--ok); } .dot.err { background: var(--err); } .dot.warn { background: var(--warn); }
.panel { position: absolute; right: 0; bottom: 44px; width: 320px; max-width: calc(100vw - 32px); padding: 12px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--bg); box-shadow: 0 4px 16px rgba(0,0,0,.25); display: grid; gap: 8px; }
.server { display: grid; gap: 2px; }
.server .name { font-weight: 600; }
.small { font-size: 12px; word-break: break-word; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.notice { position: absolute; right: 0; bottom: 44px; width: 300px; max-width: calc(100vw - 32px); padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--warn); background: var(--bg); display: grid; gap: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
`);

interface PillView {
  state: BridgeState | null;
  chatOn: boolean;
  notice: Notice | null;
  invalid: boolean;
}

export class Pill {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private open = false;
  private last: PillView = { state: null, chatOn: true, notice: null, invalid: false };
  private readonly handlers: PillHandlers;

  constructor(handlers: PillHandlers) {
    this.handlers = handlers;
    this.host = document.createElement("gmb-status");
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.adoptedStyleSheets = [PILL_SHEET];
    document.documentElement.append(this.host);
  }

  render(view: PillView): void {
    this.last = view;
    if (!this.host.isConnected) document.documentElement.append(this.host);
    this.host.toggleAttribute("data-dark", dark);
    const { state, chatOn, notice, invalid } = view;
    const live = state?.servers.filter((s) => s.status === "ok") ?? [];
    const failed = state?.servers.some((s) => s.status === "error") ?? false;
    let dot = "";
    let label = "MCP";
    if (invalid) dot = "err";
    else if (!state || !state.enabled) label = "MCP · " + t("statusOff");
    else {
      dot = notice ? "warn" : live.length && chatOn ? "ok" : failed ? "err" : "";
      label = `MCP · ${t("tools", { n: state.tools.length })}`;
    }
    const pill = h("button", { class: "pill", title: "Gemini MCP Bridge" }, h("span", { class: `dot ${dot}` }), label);
    onTrustedClick(pill, () => {
      this.open = !this.open;
      this.render(this.last);
    });
    const children: Node[] = [pill];
    if (invalid) children.push(h("div", { class: "notice" }, t("reloadPage")));
    else if (notice && !this.open) children.push(this.noticeBox(notice));
    else if (this.open) children.push(this.panel(state, chatOn));
    this.root.replaceChildren(...children);
  }

  private noticeBox(n: Notice): HTMLElement {
    const box = h("div", { class: "notice", role: "status" }, h("div", {}, n.text));
    if (n.action) {
      const b = h("button", { class: "primary" }, n.action.label);
      onTrustedClick(b, n.action.run);
      box.append(h("div", { class: "buttons" }, b));
    }
    return box;
  }

  private panel(state: BridgeState | null, chatOn: boolean): HTMLElement {
    const panel = h("div", { class: "panel" });
    if (!state || !state.enabled) panel.append(h("div", {}, t("bridgeOff")));
    else {
      const toggle = h("input", { type: "checkbox" });
      toggle.checked = chatOn;
      toggle.addEventListener("change", (e) => {
        if (e.isTrusted) this.handlers.onToggleChat(toggle.checked);
        else toggle.checked = !toggle.checked;
      });
      panel.append(h("label", {}, toggle, t("useInChat")));
      for (const s of state.servers) {
        const status = { off: t("statusOff"), ok: t("statusOk"), error: t("statusError"), connecting: t("statusConnecting") }[s.status];
        const cls = s.status === "ok" ? "ok" : s.status === "error" ? "err" : "muted";
        panel.append(
          h(
            "div",
            { class: "server" },
            h("div", {}, h("span", { class: "name" }, s.name), " ", h("span", { class: cls }, status), s.status === "ok" ? ` · ${t("tools", { n: s.toolCount })}` : ""),
            h("div", { class: "small muted" }, s.url),
            s.error ? h("div", { class: "small err" }, s.error) : null,
          ),
        );
      }
      if (!state.servers.some((s) => s.status === "ok")) panel.append(h("div", { class: "small muted" }, t("noServer")));
    }
    const refresh = h("button", {}, t("refresh"));
    onTrustedClick(refresh, () => this.handlers.onRefresh());
    const settings = h("button", {}, t("settings"));
    onTrustedClick(settings, () => this.handlers.onSettings());
    panel.append(h("div", { class: "buttons" }, refresh, settings));
    return panel;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Chips over the messages the extension wrote

const PAGE_CSS = `
.gmb-hidden-line { display: none !important; }
.gmb-chip { display: inline-flex; align-items: center; gap: 6px; margin: 2px 0 4px; padding: 2px 10px; border-radius: 999px;
  font-size: 12px; line-height: 20px; cursor: pointer; user-select: none; background: rgba(127,127,127,.16); opacity: .9; }
.gmb-chip:hover, .gmb-chip:focus-visible { opacity: 1; }
`;

export function installPageStyle(): void {
  if (document.getElementById("gmb-page-style")) return;
  (document.head ?? document.documentElement).append(h("style", { id: "gmb-page-style" }, PAGE_CSS));
}

/**
 * Puts a chip in front of `lines` and hides them; a click (or Enter, Space) on the chip shows them again. `key`
 * tells apart two chips in one message (instructions, then results). Writes to the page only what changed.
 */
export function collapse(lines: HTMLElement[], label: string, key = "main"): void {
  if (!lines.length) return;
  const before = lines[0].previousElementSibling;
  let chip = before instanceof HTMLElement && before.classList.contains("gmb-chip") && before.dataset.key === key ? before : null;
  if (!chip) {
    const c = h("span", { class: "gmb-chip", role: "button", tabindex: "0", "data-key": key });
    const toggle = (e: Event) => {
      e.stopPropagation();
      const open = c.dataset.open !== "1";
      c.dataset.open = open ? "1" : "0";
      for (const l of lines) l.classList.toggle("gmb-hidden-line", !open);
    };
    c.addEventListener("click", toggle);
    c.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle(e);
      }
    });
    lines[0].before(c);
    chip = c;
  }
  const text = `🔧 ${label}`;
  if (chip.textContent !== text) chip.textContent = text;
  const hide = chip.dataset.open !== "1";
  for (const l of lines) if (l.classList.contains("gmb-hidden-line") !== hide) l.classList.toggle("gmb-hidden-line", hide);
}
