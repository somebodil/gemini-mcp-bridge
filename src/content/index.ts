// The content script on gemini.google.com. It
//  1. puts the tool instructions in front of the first message the user sends in a conversation,
//  2. waits until Gemini's reply to that message is finished, reads the tool calls in it and runs them (asking
//     first unless the tool may run by itself),
//  3. sends the results back as the next message, and goes on until Gemini answers without a call.
//
// Which reply is handled: only the answer to a message this tab sent. When a message goes out, the extension
// notes which replies are on the page already (none of them is the answer) and what the message says; the
// answer is the first new reply that directly follows that message. Opening an old conversation, reloading,
// or switching chats therefore never runs the calls on the page.

import { noSuchTool, type BridgeState, type ExposedTool, type PortReply, type Request } from "../shared/config.ts";
import { t } from "../shared/i18n.ts";
import {
  buildInstructions,
  buildToolsUpdate,
  formatResults,
  looksLikeCall,
  MARK,
  parseCalls,
  resultsEnd,
  summarizeResults,
  toolsHash,
  TOOLS_HEADING,
  type Outcome,
  type ParsedCall,
} from "../shared/protocol.ts";
import * as G from "./gemini.ts";
import { Card, collapse, installPageStyle, Pill, type Notice, type Row } from "./ui.ts";

const MAX_CALLS_PER_REPLY = 10;
const STABLE_MS = 1200;
const STATE_MAX_AGE_MS = 30_000;
/** A message whose answer does not show up in this time is no longer waited for. */
const EXPECT_MAX_MS = 5 * 60_000;

type Result = Extract<PortReply, { type: "result" }>;

/** The message this tab sent and waits for the answer to. */
interface Expect {
  /** Start and end of the message without whitespace: the answer follows the user message that matches. */
  print: string;
  /** Ids of the replies on the page when the message went out. */
  before: Set<string>;
  at: number;
  /** Hash of the instructions the message carried, saved for the conversation once the answer came. */
  given?: string;
}

let state: BridgeState | null = null;
let stateAt = 0;
let invalid = false;
let notice: Notice | null = null;

let expecting: Expect | null = null;
const handled = new Set<string>();
let latest = { id: "", text: "", since: 0 };
let userStopped = false;
let rounds = 0;
/** True while the extension itself sends, so that its own click is not taken for the user's. */
let programmatic = false;
/** True while a send of the user is held back to add text in front of it. */
let holding = false;
/** The calls being handled; aborted when the user leaves the chat. */
let run: AbortController | null = null;
/** Results that wait because the user is writing; they go in front of the user's next message. */
let pendingResults: string | null = null;
let lastPath = location.pathname;

const cards = new Map<string, Card>();
const pill = new Pill({
  onToggleChat: (on) => {
    setChatOn(on);
    render();
  },
  onRefresh: () => void refreshState(true),
  onSettings: () => void send({ type: "openOptions" }),
});

/** With localStorage["gmb-debug"] = "1" on gemini.google.com, the steps go to the console. */
function dbg(...args: unknown[]): void {
  try {
    if (localStorage.getItem("gmb-debug") === "1") console.debug("[gmb]", ...args);
  } catch {
    // storage blocked
  }
}

// ---------------------------------------------------------------------------------------------------------
// Talking to the service worker

async function send<T>(msg: Request): Promise<T | undefined> {
  try {
    return await chrome.runtime.sendMessage<Request, T>(msg);
  } catch (e) {
    if (!chrome.runtime?.id || String(e).includes("context invalidated")) {
      invalid = true;
      render();
    }
    return undefined;
  }
}

async function refreshState(force = false): Promise<void> {
  const s = await send<BridgeState & { error?: string }>({ type: "getState", refresh: force });
  if (s && !s.error) {
    state = s;
    stateAt = Date.now();
  }
  render();
}

/** One call through a port: pinged while it runs (keeps the service worker alive), dropped on abort (stops it). */
function callTool(tool: string, args: Record<string, unknown>, approved: boolean, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve) => {
    let done = false;
    let port: chrome.runtime.Port | undefined;
    const ping = setInterval(() => {
      try {
        port?.postMessage({ type: "ping" });
      } catch {
        // the disconnect handler reports it
      }
    }, 20_000);
    const finish = (r: Result) => {
      if (done) return;
      done = true;
      clearInterval(ping);
      signal.removeEventListener("abort", onAbort);
      try {
        port?.disconnect();
      } catch {
        // gone already
      }
      resolve(r);
    };
    const onAbort = () => finish({ type: "result", ok: false, text: "Cancelled: the user left the conversation.", durationMs: 0 });
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      port = chrome.runtime.connect({ name: "call" });
    } catch {
      invalid = true;
      render();
      return finish({ type: "result", ok: false, text: "The browser extension was reloaded; the call did not run.", durationMs: 0 });
    }
    port.onMessage.addListener((m: PortReply) => {
      if (m.type === "result") finish(m);
    });
    port.onDisconnect.addListener(() => finish({ type: "result", ok: false, text: "The browser extension stopped during the call.", durationMs: 0 }));
    port.postMessage({ type: "call", tool, arguments: args, approved });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Per-conversation memory

function chatKey(path = location.pathname): string {
  return G.conversationId(path) ?? "new";
}

function chatOn(): boolean {
  return sessionStorage.getItem(`gmb-off:${chatKey()}`) !== "1";
}

function setChatOn(on: boolean): void {
  if (on) sessionStorage.removeItem(`gmb-off:${chatKey()}`);
  else sessionStorage.setItem(`gmb-off:${chatKey()}`, "1");
}

function active(): boolean {
  return !invalid && !!state?.enabled && chatOn();
}

const GIVEN_KEY = "given";

async function givenHash(): Promise<string | null> {
  const id = G.conversationId();
  if (id) {
    const all = ((await chrome.storage.local.get(GIVEN_KEY))[GIVEN_KEY] ?? {}) as Record<string, [string, number]>;
    if (all[id]) return all[id][0];
  }
  // instructions given elsewhere (another computer, before a reinstall): the hash is unknown
  return G.queries().some((q) => q.textContent?.includes(MARK.instructions)) ? "?" : null;
}

async function saveGiven(id: string, hash: string): Promise<void> {
  const all = ((await chrome.storage.local.get(GIVEN_KEY))[GIVEN_KEY] ?? {}) as Record<string, [string, number]>;
  all[id] = [hash, Date.now()];
  const entries = Object.entries(all)
    .sort((a, b) => b[1][1] - a[1][1])
    .slice(0, 500);
  await chrome.storage.local.set({ [GIVEN_KEY]: Object.fromEntries(entries) });
}

// ---------------------------------------------------------------------------------------------------------
// Which reply answers which message

function fingerprint(text: string): string {
  const s = text.replace(/\s+/g, "");
  return s.length <= 200 ? s : `${s.slice(0, 100)}…${s.slice(-100)}`;
}

function queryText(q: HTMLElement): string {
  return G.queryLines(q)
    .map((l) => l.textContent ?? "")
    .join("\n");
}

function replyIds(): Set<string> {
  return new Set(G.responses().map((r, i) => G.responseId(r, i)));
}

/** Notes the message about to go out: its answer is the next reply to handle. */
function expect(text: string, given?: string): void {
  expecting = { print: fingerprint(text), before: replyIds(), at: Date.now(), given };
  dbg("expecting", expecting.print.slice(0, 60), [...expecting.before].length);
}

/** The user message right before `reply` on the page. */
function queryBefore(reply: HTMLElement): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const q of G.queries()) if (q.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) found = q;
  return found;
}

/** The last reply, when it is the answer to the expected message. */
function awaitedReply(): { reply: HTMLElement; id: string } | null {
  if (!expecting) return null;
  const list = G.responses();
  const reply = list.at(-1);
  if (!reply) return null;
  const id = G.responseId(reply, list.length - 1);
  if (handled.has(id) || expecting.before.has(id)) return null;
  const q = queryBefore(reply);
  if (!q || fingerprint(queryText(q)) !== expecting.print) return null;
  return { reply, id };
}

// ---------------------------------------------------------------------------------------------------------
// 1. Text in front of the user's message: the instructions, and results that waited

function onUserSend(e: Event): void {
  // a script of the page can dispatch events too; only the user's own count
  if (programmatic || !e.isTrusted) return;
  if (holding) {
    // pressed again while the first send is held: one send is enough
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  dbg("user send", e.type, { active: active(), tools: state?.tools.length });
  if (!active()) return;
  rounds = 0;
  userStopped = false;
  if (notice?.action?.label === t("continue")) notice = null;
  const s = state;
  if (!pendingResults && (!s || s.tools.length === 0)) {
    expect(G.editorText());
    return;
  }
  // what goes in front is decided asynchronously, so the send is held back and repeated
  e.preventDefault();
  e.stopImmediatePropagation();
  holding = true;
  void (async () => {
    try {
      if (Date.now() - stateAt > STATE_MAX_AGE_MS) await refreshState();
      const parts: string[] = [];
      let given: string | undefined;
      const cur = state;
      if (cur && cur.enabled && cur.tools.length) {
        const hash = toolsHash(cur.tools, cur.notes);
        const had = await givenHash();
        if (had !== hash) {
          parts.push(had === null ? buildInstructions(cur.tools, cur.notes) : buildToolsUpdate(cur.tools, cur.notes));
          given = hash;
        }
      }
      if (pendingResults) {
        parts.push(pendingResults);
        pendingResults = null;
        if (notice?.action?.label === t("sendResults")) notice = null;
        render();
      }
      if (parts.length) G.insertAtStart(`${parts.join("\n\n")}\n\n`);
      expect(G.editorText(), given);
      if (!(await submitProgrammatically())) expecting = null;
    } finally {
      holding = false;
      render();
    }
  })();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || !G.isInEditor(e.target)) return;
  if (G.editorText() === "") return;
  onUserSend(e);
}

function onClick(e: MouseEvent): void {
  if (!e.isTrusted) return;
  if (G.isStopButton(e.target)) {
    userStopped = true;
    return;
  }
  if (G.isSendButton(e.target)) onUserSend(e);
}

async function submitProgrammatically(): Promise<boolean> {
  programmatic = true;
  try {
    return await G.submit();
  } finally {
    programmatic = false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// 2. Watching the replies

function tick(): void {
  if (location.pathname !== lastPath) onNavigate(lastPath);
  const generating = G.isGenerating();
  // Gemini writes, but not for a message this tab sent (a suggestion chip, "regenerate"): the answer is the
  // reply that comes after the replies there are now, to the user message that is last now
  if (generating && !expecting && active()) {
    const qs = G.queries();
    const last = qs.at(-1);
    if (last) expecting = { print: fingerprint(queryText(last)), before: replyIds(), at: Date.now() };
  }
  if (expecting && Date.now() - expecting.at > EXPECT_MAX_MS) expecting = null;
  decorate(generating);
  if (run || generating) return;
  const awaited = awaitedReply();
  if (!awaited) return;
  const text = G.responseText(awaited.reply);
  if (latest.id !== awaited.id || latest.text !== text) {
    latest = { id: awaited.id, text, since: Date.now() };
    return;
  }
  if (Date.now() - latest.since < STABLE_MS) return;
  handled.add(awaited.id);
  const given = expecting?.given;
  expecting = null;
  // the answer came: the instructions reached this conversation
  const id = G.conversationId();
  if (given && id) void saveGiven(id, given);
  dbg("reply finished", awaited.id);
  void handleReply(awaited.reply, awaited.id);
}

function onNavigate(from: string): void {
  lastPath = location.pathname;
  const was = chatKey(from);
  const now = chatKey();
  if (was === "new" && now !== "new") {
    // a new chat got its address (or the user opened another chat: then the answer check fails, nothing runs)
    if (sessionStorage.getItem("gmb-off:new") === "1") sessionStorage.setItem(`gmb-off:${now}`, "1");
  } else {
    // another conversation: nothing of this one goes there
    expecting = null;
    run?.abort();
    rounds = 0;
    notice = null;
    pendingResults = null;
  }
  sessionStorage.removeItem("gmb-off:new");
  render();
}

/** Cards under the call blocks, chips over the instruction and result messages. */
function decorate(generating: boolean): void {
  const list = G.responses();
  const awaitedId = awaitedReply()?.id;
  list.forEach((resp, i) => {
    const id = G.responseId(resp, i);
    const live = id === awaitedId || (generating && i === list.length - 1 && !handled.has(id) && !!expecting && !expecting.before.has(id));
    G.codeBlocks(resp)
      .filter((b) => looksLikeCall(b.text))
      .forEach((b, j) => {
        const key = `${id}#${j}`;
        let card = cards.get(key);
        if (!card) {
          card = new Card();
          cards.set(key, card);
        }
        if (card.mode !== "live") {
          const mode = live ? "waiting" : "earlier";
          if (card.mode !== mode || !card.rows.length) {
            const parsed = parseCalls([b.text]);
            card.setRows(parsed.calls.length ? parsed.calls.map((c) => ({ tool: c.tool, args: c.arguments })) : [{ tool: "mcp_call" }], mode);
            card.mode = mode;
          }
        }
        if (card.host.previousElementSibling !== b.anchor) b.anchor.after(card.host);
      });
  });
  for (const q of G.queries()) {
    const box = G.queryTextBox(q);
    const lines = G.queryLines(q);
    if (!box || !lines.length) continue;
    const texts = lines.map((l) => (l.textContent ?? "").trim());
    if (texts[0]?.startsWith(MARK.results)) {
      // results, perhaps followed by the user's own text
      const endR = resultsEnd(texts, 0);
      collapse(box, lines.slice(0, endR), t("chipResults", { s: summarizeResults(texts.slice(0, endR).join("\n")) }));
      continue;
    }
    const start = texts.findIndex((x) => x.startsWith(MARK.instructions) || x.startsWith(MARK.toolsUpdate));
    if (start < 0) continue;
    const end = texts.indexOf(MARK.instructionsEnd, start);
    const block = lines.slice(start, end < 0 ? undefined : end + 1);
    const block_ = texts.slice(start, end < 0 ? undefined : end);
    const heading = block_.findIndex((x) => x.startsWith(TOOLS_HEADING));
    const count = heading < 0 ? 0 : block_.slice(heading + 1).filter((x) => /^- \S+: /.test(x)).length;
    collapse(box, block, texts[start].startsWith(MARK.instructions) ? t("chipInstructions", { n: count }) : t("chipUpdate"));
    // results that waited for the user's message come after the instructions in the same message
    const r = texts.findIndex((x, k) => k > (end < 0 ? start : end) && x.startsWith(MARK.results));
    if (r >= 0) {
      const endR = resultsEnd(texts, r);
      collapse(box, lines.slice(r, endR), t("chipResults", { s: summarizeResults(texts.slice(r, endR).join("\n")) }), "results");
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. Running the calls and sending the results

interface Item {
  card: Card;
  calls: ParsedCall[];
  problems: { snippet: string; error: string }[];
}

function itemsOf(resp: HTMLElement, id: string): Item[] {
  const items: Item[] = [];
  let j = 0;
  for (const b of G.codeBlocks(resp)) {
    if (!looksLikeCall(b.text)) continue;
    const parsed = parseCalls([b.text]);
    let card = cards.get(`${id}#${j}`);
    if (!card) {
      card = new Card();
      cards.set(`${id}#${j}`, card);
      b.anchor.after(card.host);
    }
    items.push({ card, ...parsed });
    j++;
  }
  if (!items.length) {
    // Gemini dropped the code fence: the card goes at the end of the reply
    const parsed = parseCalls([], G.responseText(resp));
    if (parsed.calls.length) {
      let card = cards.get(`${id}#text`);
      if (!card) {
        card = new Card();
        cards.set(`${id}#text`, card);
        (resp.querySelector<HTMLElement>(G.SEL.responseContent) ?? resp).after(card.host);
      }
      items.push({ card, ...parsed });
    }
  }
  return items.filter((it) => it.calls.length || it.problems.length);
}

async function handleReply(resp: HTMLElement, id: string): Promise<void> {
  if (!active() || userStopped) return;
  const items = itemsOf(resp, id);
  dbg(
    "calls",
    items.map((it) => it.calls.map((c) => c.tool)),
    items.map((it) => it.problems),
  );
  if (!items.length) return;
  // the limit holds before anything runs: the calls of this reply wait for "Continue"
  if (rounds >= (state?.settings.maxRounds ?? 20)) {
    for (const it of items) {
      it.card.setRows(
        it.calls.map((c) => ({ tool: c.tool, args: c.arguments })),
        "skipped",
      );
      it.card.mode = "live";
    }
    notice = {
      text: t("paused", { n: rounds }),
      action: {
        label: t("continue"),
        run: () => {
          rounds = 0;
          notice = null;
          render();
          void handleReply(resp, id);
        },
      },
    };
    render();
    return;
  }

  const ctrl = new AbortController();
  run = ctrl;
  try {
    if (Date.now() - stateAt > STATE_MAX_AGE_MS) await refreshState();
    const outcomes: Outcome[] = [];
    let count = 0;
    for (const it of items) {
      const rows = it.card.setRows(
        it.calls.map((c) => ({ tool: c.tool, args: c.arguments })),
        "waiting",
      );
      it.card.mode = "live";
      for (const p of it.problems) {
        outcomes.push({
          tool: "mcp_call",
          ok: false,
          text: `${p.error}\nYou wrote: ${p.snippet}\nWrite the call again as {"mcp_call": {"tool": "TOOL_NAME", "arguments": {...}}} in a code block.`,
        });
      }
      for (let k = 0; k < it.calls.length; k++) {
        const call = it.calls[k];
        if (ctrl.signal.aborted) {
          rows[k].set("skipped");
          continue;
        }
        if (++count > MAX_CALLS_PER_REPLY) {
          rows[k].set("skipped");
          outcomes.push({ tool: call.tool, ok: false, text: `Not run: at most ${MAX_CALLS_PER_REPLY} calls per reply. Call it again in the next reply.` });
          continue;
        }
        outcomes.push(await runCall(call, rows[k], ctrl.signal));
      }
    }
    // the user went to another chat: the results do not belong there
    if (ctrl.signal.aborted || !replyIds().has(id)) return;
    await deliver(formatResults(outcomes, state?.settings.maxResultChars ?? 20000));
  } finally {
    if (run === ctrl) run = null;
  }
}

async function runCall(call: ParsedCall, row: Row, signal: AbortSignal): Promise<Outcome> {
  let tool: ExposedTool | undefined = state?.tools.find((x) => x.name === call.tool);
  if (!tool) {
    // the page's list may be old (the server came up later): ask the service worker for the current one
    await refreshState(true);
    tool = state?.tools.find((x) => x.name === call.tool);
  }
  if (!tool) {
    const text = noSuchTool(call.tool, state?.tools.map((x) => x.name) ?? []);
    row.set("error", { output: text });
    return { tool: call.tool, ok: false, text };
  }
  let approved = false;
  const ask = async (): Promise<Outcome | null> => {
    const decision = await row.ask(signal);
    if (decision === "deny") {
      row.set("denied");
      return { tool: call.tool, ok: false, text: signal.aborted ? "Not run: the user left the conversation." : "The user declined this call." };
    }
    if (decision === "always" && tool) {
      tool.policy = "auto";
      void send({ type: "setPolicy", tool: tool.name, policy: "auto" });
    }
    approved = true;
    return null;
  };
  if (tool.policy !== "auto") {
    const refused = await ask();
    if (refused) return refused;
  }
  row.set("running");
  let r = await callTool(call.tool, call.arguments, approved, signal);
  if (r.needsApproval) {
    // the tool was set to "ask" after the page's list was fetched
    const refused = await ask();
    if (refused) return refused;
    row.set("running");
    r = await callTool(call.tool, call.arguments, true, signal);
  }
  row.set(r.ok ? "done" : "error", { output: r.text, durationMs: r.durationMs });
  return { tool: call.tool, ok: r.ok, text: r.text };
}

async function deliver(message: string): Promise<void> {
  const settings = state?.settings;
  const draft = G.editorText();
  if (settings && !settings.autoSend) {
    G.replaceText(draft ? `${message}\n\n${draft}` : message);
    notice = { text: t("resultsInBox") };
    render();
    return;
  }
  if (draft) {
    // the user is writing: the results go in front of their message when they send it, or now on a click
    pendingResults = message;
    notice = {
      text: t("resultsWaiting"),
      action: {
        label: t("sendResults"),
        run: () => {
          const waiting = pendingResults;
          if (!waiting) return;
          pendingResults = null;
          void sendNow(waiting, G.editorText());
        },
      },
    };
    render();
    return;
  }
  await sendNow(message, "");
}

async function sendNow(message: string, draft: string): Promise<void> {
  notice = null;
  const text = draft ? `${message}\n\n${draft}` : message;
  G.replaceText(text);
  rounds++;
  expect(text);
  const ok = await submitProgrammatically();
  dbg("results sent", ok);
  if (!ok) {
    expecting = null;
    notice = { text: t("sendFailed") };
  }
  render();
}

// ---------------------------------------------------------------------------------------------------------

function render(): void {
  pill.render({ state, chatOn: chatOn(), notice, invalid });
}

function start(): void {
  installPageStyle();
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onClick, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) void refreshState(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - stateAt > STATE_MAX_AGE_MS) void refreshState();
  });
  setInterval(tick, 400);
  void refreshState();
  render();
}

start();
