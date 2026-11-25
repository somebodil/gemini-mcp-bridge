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

import type { BridgeState, CallReply, ExposedTool, Request } from "../shared/config.ts";
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
  type ParseProblem,
} from "../shared/protocol.ts";
import { noSuchTool } from "../shared/tools.ts";
import * as G from "./gemini.ts";
import { Card, collapse, installPageStyle, pageIsDark, Pill, setTheme, type Notice, type Row } from "./ui.ts";

const MAX_CALLS_PER_REPLY = 10;
const STABLE_MS = 1200;
const TICK_MS = 400;
const STATE_MAX_AGE_MS = 30_000;
/** A held send waits at most this long for a fresh tool list, then goes with the one it has. */
const FRESH_WAIT_MS = 1500;
/** A message whose answer has not started in this time is no longer waited for. */
const EXPECT_MAX_MS = 5 * 60_000;

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
let latest = { id: "", raw: "", since: 0 };
let userStopped = false;
let rounds = 0;
/** True while a send of the user is held back to add text in front of it. */
let holding = false;
/** The calls being handled; aborted when the user leaves the chat or turns it off. */
let run: AbortController | null = null;
/** Results that wait because the user is writing; they go in front of the user's next message. */
let pendingResults: string | null = null;
let lastPath = location.pathname;
let timer: ReturnType<typeof setInterval> | undefined;

/** Cards by reply id and block number, for the conversation on the page. */
const cards = new Map<string, Card>();
/** Messages already given their chips, and earlier replies already given their cards: skipped by each tick. */
let doneQueries = new WeakSet<HTMLElement>();
let doneReplies = new WeakSet<HTMLElement>();

const pill = new Pill({
  onToggleChat: (on) => {
    setChatOn(on);
    if (!on) {
      // off means off: a run in progress stops, waiting results are dropped
      run?.abort();
      pendingResults = null;
      notice = null;
    }
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
// The extension's own life: after an update or a reload, this script is cut off and stops itself

function alive(): boolean {
  if (chrome.runtime?.id) return true;
  if (!invalid) {
    invalid = true;
    clearInterval(timer);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onClick, true);
    render();
  }
  return false;
}

async function send<T>(msg: Request): Promise<T | undefined> {
  if (!alive()) return undefined;
  try {
    return await chrome.runtime.sendMessage<Request, T>(msg);
  } catch {
    alive();
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

/** A tool list no older than half a minute, waiting at most `maxWait` for it (a hung server must not hold the page). */
async function freshState(maxWait = Infinity): Promise<void> {
  if (Date.now() - stateAt <= STATE_MAX_AGE_MS) return;
  await Promise.race([refreshState(), new Promise((r) => setTimeout(r, maxWait))]);
}

/** One call through a port: pinged while it runs (keeps the service worker alive), dropped on abort (stops it). */
function callTool(tool: string, args: Record<string, unknown>, approved: boolean, signal: AbortSignal): Promise<CallReply> {
  const cancelled: CallReply = { ok: false, text: "Cancelled: the user left the conversation or turned the tools off.", durationMs: 0 };
  if (signal.aborted) return Promise.resolve(cancelled);
  if (!alive()) return Promise.resolve({ ok: false, text: "The browser extension was reloaded; the call did not run.", durationMs: 0 });
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "call" });
    let done = false;
    const ping = setInterval(() => {
      try {
        port.postMessage({ type: "ping" });
      } catch {
        // the disconnect handler reports it
      }
    }, 20_000);
    const finish = (r: CallReply) => {
      if (done) return;
      done = true;
      clearInterval(ping);
      signal.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {
        // gone already
      }
      resolve(r);
    };
    const onAbort = () => finish(cancelled);
    signal.addEventListener("abort", onAbort, { once: true });
    port.onMessage.addListener((m: CallReply) => finish(m));
    port.onDisconnect.addListener(() => finish({ ok: false, text: "The browser extension stopped during the call.", durationMs: 0 }));
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
  dbg("expecting", expecting.print.slice(0, 60), expecting.before.size);
}

/** The user message right before `reply` on the page (walking back from the last one). */
function queryBefore(reply: HTMLElement): HTMLElement | null {
  const qs = G.queries();
  for (let i = qs.length - 1; i >= 0; i--) if (qs[i].compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) return qs[i];
  return null;
}

/** The last reply, when it is the answer to the expected message. */
function awaitedReply(list: HTMLElement[]): { reply: HTMLElement; id: string } | null {
  if (!expecting) return null;
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
  // a script of the page can dispatch events too (and the extension's own send is a script click): only the
  // user's own count
  if (!e.isTrusted || !alive()) return;
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
  if (notice?.kind === "paused") notice = null;
  if (!pendingResults && (!state || state.tools.length === 0)) {
    expect(G.editorText());
    return;
  }
  // what goes in front is decided asynchronously, so the send is held back and repeated
  e.preventDefault();
  e.stopImmediatePropagation();
  holding = true;
  void (async () => {
    try {
      await freshState(FRESH_WAIT_MS);
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
        if (notice?.kind === "results") notice = null;
        render();
      }
      if (parts.length) G.insertAtStart(`${parts.join("\n\n")}\n\n`);
      expect(G.editorText(), given);
    } catch (err) {
      // the user's message goes out in any case, as they wrote it
      dbg("could not prepare the message", err);
    }
    // still holding until the message is out: an Enter meanwhile would add the text a second time
    try {
      if (!(await G.submit())) expecting = null;
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

// ---------------------------------------------------------------------------------------------------------
// 2. Watching the replies

function tick(): void {
  if (!alive()) return;
  if (location.pathname !== lastPath) onNavigate(lastPath);
  setTheme(pageIsDark());
  const generating = G.isGenerating();
  // Gemini writes, but not for a message this tab sent (a suggestion chip, "regenerate"): the answer is the
  // reply that comes after the replies there are now, to the user message that is last now
  if (generating && !expecting && active()) {
    const last = G.queries().at(-1);
    if (last) expecting = { print: fingerprint(queryText(last)), before: replyIds(), at: Date.now() };
  }
  // a reply that is being written is still awaited, however long it takes
  if (expecting && !generating && Date.now() - expecting.at > EXPECT_MAX_MS) expecting = null;
  const list = G.responses();
  const awaited = awaitedReply(list);
  decorate(list, awaited?.id, generating);
  if (run || generating || !awaited) return;
  const raw = G.responseRaw(awaited.reply);
  if (latest.id !== awaited.id || latest.raw !== raw) {
    latest = { id: awaited.id, raw, since: Date.now() };
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
    // another conversation: nothing of this one goes there, and its cards are let go
    expecting = null;
    run?.abort();
    rounds = 0;
    notice = null;
    pendingResults = null;
    for (const c of cards.values()) c.drop();
    cards.clear();
    handled.clear();
    doneQueries = new WeakSet();
    doneReplies = new WeakSet();
  }
  sessionStorage.removeItem("gmb-off:new");
  render();
}

function cardFor(key: string, anchor: HTMLElement): Card {
  let card = cards.get(key);
  if (!card) {
    card = new Card();
    cards.set(key, card);
  }
  if (card.host.previousElementSibling !== anchor) anchor.after(card.host);
  return card;
}

/** Cards under the call blocks, chips over the instruction and result messages: each done once. */
function decorate(list: HTMLElement[], awaitedId: string | undefined, generating: boolean): void {
  list.forEach((resp, i) => {
    const isLast = i === list.length - 1;
    if (doneReplies.has(resp)) return;
    const id = G.responseId(resp, i);
    const live = id === awaitedId || (generating && isLast && !handled.has(id) && !!expecting && !expecting.before.has(id));
    let complete = true;
    G.codeBlocks(resp)
      .filter((b) => looksLikeCall(b.text))
      .forEach((b, j) => {
        const card = cardFor(`${id}#${j}`, b.anchor);
        if (card.mode === "live") return;
        const mode = live ? "waiting" : "earlier";
        if (card.mode !== mode || card.text !== b.text) {
          const parsed = parseCalls([b.text]);
          card.setCalls(parsed.calls, parsed.problems, mode);
          card.mode = mode;
          card.text = b.text;
        }
        if (!card.host.isConnected) complete = false;
      });
    // the last reply may still change; earlier ones are done once their cards are placed
    if (!isLast && complete) doneReplies.add(resp);
  });
  for (const q of G.queries()) {
    const box = G.queryTextBox(q);
    if (!box || doneQueries.has(box)) continue;
    const lines = G.queryLines(q);
    if (!lines.length) continue;
    doneQueries.add(box);
    const texts = lines.map((l) => (l.textContent ?? "").trim());
    if (texts[0]?.startsWith(MARK.results)) {
      // results, perhaps followed by the user's own text
      const endR = resultsEnd(texts, 0);
      collapse(lines.slice(0, endR), t("chipResults", { s: summarizeResults(texts.slice(0, endR).join("\n")) }));
      continue;
    }
    const start = texts.findIndex((x) => x.startsWith(MARK.instructions) || x.startsWith(MARK.toolsUpdate));
    if (start < 0) continue;
    const end = texts.indexOf(MARK.instructionsEnd, start);
    const block = texts.slice(start, end < 0 ? undefined : end);
    const heading = block.findIndex((x) => x.startsWith(TOOLS_HEADING));
    const count = heading < 0 ? 0 : block.slice(heading + 1).filter((x) => /^- \S+: /.test(x)).length;
    collapse(lines.slice(start, end < 0 ? undefined : end + 1), texts[start].startsWith(MARK.instructions) ? t("chipInstructions", { n: count }) : t("chipUpdate"));
    // results that waited for the user's message come after the instructions in the same message
    const r = texts.findIndex((x, k) => k > (end < 0 ? start : end) && x.startsWith(MARK.results));
    if (r >= 0) {
      const endR = resultsEnd(texts, r);
      collapse(lines.slice(r, endR), t("chipResults", { s: summarizeResults(texts.slice(r, endR).join("\n")) }), "results");
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. Running the calls and sending the results

interface Item {
  card: Card;
  calls: ParsedCall[];
  problems: ParseProblem[];
}

/** The calls of a reply, each block with its card, already live (no tick turns them into "earlier"). */
function itemsOf(resp: HTMLElement, id: string): Item[] {
  const items: Item[] = [];
  let j = 0;
  for (const b of G.codeBlocks(resp)) {
    if (!looksLikeCall(b.text)) continue;
    items.push({ card: cardFor(`${id}#${j++}`, b.anchor), ...parseCalls([b.text]) });
  }
  if (!items.length) {
    // Gemini dropped the code fence: the card goes at the end of the reply
    const parsed = parseCalls([], G.responseText(resp));
    if (parsed.calls.length) items.push({ card: cardFor(`${id}#text`, resp.querySelector<HTMLElement>(G.SEL.responseContent) ?? resp), ...parsed });
  }
  const found = items.filter((it) => it.calls.length || it.problems.length);
  for (const it of found) it.card.mode = "live";
  return found;
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
  if (rounds >= (state?.behavior.maxRounds ?? 20)) {
    for (const it of items) it.card.setCalls(it.calls, it.problems, "skipped");
    notice = {
      kind: "paused",
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
    await freshState();
    const outcomes: Outcome[] = [];
    let count = 0;
    for (const it of items) {
      const rows = it.card.setCalls(it.calls, it.problems, "waiting");
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
    // the user went to another chat or turned the tools off: the results do not go anywhere
    if (ctrl.signal.aborted || !replyIds().has(id)) return;
    await deliver(formatResults(outcomes, state?.behavior.maxResultChars ?? 20000));
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
  const known = tool;
  let approved = false;
  const ask = async (): Promise<Outcome | null> => {
    const decision = await row.ask(signal);
    if (decision === "deny") {
      row.set("denied");
      return { tool: call.tool, ok: false, text: signal.aborted ? "Not run: the user left the conversation or turned the tools off." : "The user declined this call." };
    }
    if (decision === "always") {
      known.policy = "auto";
      void send({ type: "setPolicy", tool: known.name, policy: "auto" });
    }
    approved = true;
    return null;
  };
  if (known.policy !== "auto") {
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
  const draft = G.editorText();
  if (state && !state.behavior.autoSend) {
    G.replaceText(draft ? `${message}\n\n${draft}` : message);
    notice = { kind: "inBox", text: t("resultsInBox") };
    render();
    return;
  }
  if (draft) {
    // the user is writing: the results go in front of their message when they send it, or now on a click
    pendingResults = message;
    notice = {
      kind: "results",
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
  const ok = await G.submit();
  dbg("results sent", ok);
  if (!ok) {
    expecting = null;
    notice = { kind: "sendFailed", text: t("sendFailed") };
  }
  render();
}

// ---------------------------------------------------------------------------------------------------------

function render(): void {
  pill.render({ state, chatOn: chatOn(), notice, invalid });
}

function start(): void {
  installPageStyle();
  setTheme(pageIsDark());
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onClick, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    // the service worker reconnects changed servers by itself: no need to list every server again
    if (area === "local" && changes.settings) void refreshState(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void freshState();
  });
  timer = setInterval(tick, TICK_MS);
  void refreshState();
  render();
}

start();
