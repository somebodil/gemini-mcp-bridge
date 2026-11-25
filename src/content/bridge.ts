// The bridge on a chat page, whatever the site (the Page says how to find things on it). It
//  1. puts the tool instructions in front of the first message the user sends in a conversation,
//  2. waits until the reply to that message is finished, reads the tool calls in it and runs them (asking
//     first unless the tool may run by itself),
//  3. sends the results back as the next message, and goes on until the reply has no call.

import type { BridgeState, CallReply, ExposedTool, Request } from "../shared/config.ts";
import { t } from "../shared/i18n.ts";
import { buildInstructions, buildToolsUpdate, formatResults, toolsHash, type Outcome, type ParsedCall } from "../shared/protocol.ts";
import { noSuchTool } from "../shared/tools.ts";
import { layoutChange, letters, loadLayout, saveLayout, type Layout, type Role } from "./layout.ts";
import { checkLayout, Learner, outlineItems, withPicked, type RoleResult } from "./learn.ts";
import { Overlay } from "./overlay.ts";
import { Picker } from "./picker.ts";
import { dbg, deepTarget, editableOf, inputAreaRects, isOurs, pageStructure, short, sleep, type Finished, type Page } from "./page.ts";
import { installPageStyle, pageIsDark, Pill, removePageStyle, setTheme, type FlowView, type LearnBox, type Notice, type Row } from "./ui.ts";

/** Where the exchange that went out last stands, for the status line. */
type Flow =
  | { stage: "sent"; at: number; with: ("instructions" | "update" | "results")[]; wroteAt: number }
  | { stage: "asking" | "running"; at: number; tool: string; i: number; n: number }
  | { stage: "sending" | "done" | "stopped"; at: number };

const MAX_CALLS_PER_REPLY = 10;
/** After the address changed, the conversation is looked at again this long: a page may draw the other one later. */
const NAV_RECHECK_MS = 4000;
/** An event of the extension's own elements (the status button, a card): not the page's. */
const fromUs = (e: Event) => e.composedPath().some((n) => n instanceof Element && isOurs(n));
/** No reply seen this long after sending, the page not writing: the status line says so and what can be done. */
const STUCK_MS = 45_000;
/** The same this long after the page stopped writing. */
const STUCK_AFTER_WRITING_MS = 10_000;
/** "Done" and "Stopped" stay this long in the status line. */
const FLOW_SHOWN_MS = 6000;
const TICK_MS = 400;
const STATE_MAX_AGE_MS = 30_000;
/** A held send waits at most this long for a fresh tool list, then goes with the one it has. */
const FRESH_WAIT_MS = 1500;

/** Starts the bridge on the page; returns the function that stops it. */
export function startBridge(page: Page): () => void {
  let state: BridgeState | null = null;
  let stateAt = 0;
  let stopped = false;
  let notice: Notice | null = null;
  let userStopped = false;
  let rounds = 0;
  /** True while a send of the user is held back to add text in front of it. */
  let holding = false;
  /** The extension's send of the user's message did not go: the next one is left to the page as it is. */
  let passNext = false;
  /** The address changed and the conversation looked the same: looked at again until `until`. */
  let navCheck: { from: string; until: number } | null = null;
  /** The calls being handled; aborted when the user leaves the chat or turns it off. */
  let run: AbortController | null = null;
  /** Results that wait because the user is writing; they go in front of the user's next message. */
  let pendingResults: string | null = null;
  let lastAddress = page.address();
  /** Hash of the instructions this tab last sent. */
  let lastGiven: string | undefined;
  /** What the extension learned about this site (pages other than gemini.google.com). */
  let layout: Layout | null = null;
  /** While the user teaches the page: the extension only watches. */
  let learner: Learner | null = null;
  /** What it learned, shown until the user closes it (with why the last pick did not work, if it did not). */
  let results: { roles: RoleResult[]; saved: boolean; message?: string } | null = null;
  /** While the user picks a part on the page by hand. */
  let picker: Picker | null = null;
  let picking: { role: Role; current: string } | null = null;
  const overlay = new Overlay();
  let flow: Flow | null = null;
  let lastFlowText = "";
  /** When the status line's "Copy page structure" last copied (it says so for a moment), and whether it could. */
  let copiedAt = 0;
  let copiedOk = false;

  const pill = new Pill({
    generic: page.kind === "generic",
    onToggleChat: (on) => {
      setChatOn(on);
      if (!on) {
        // off means off: a run in progress stops, waiting results are dropped
        run?.abort();
        pendingResults = null;
        notice = null;
        flow = null;
      }
      render();
    },
    onRefresh: () => void refreshState(true),
    onSettings: () => void send({ type: "openOptions" }),
    onTurnOff: () => void send({ type: "turnOff" }),
    onCopyStructure: () => copy(pageStructure()),
    onLearnStart: () => startLearning(),
    onLearnStop: () => stopLearning(),
    onLearnCancel: () => {
      learner?.cancel();
      learner = null;
      render();
    },
    onShowLearned: () => showLearned(),
    onCloseResults: () => {
      results = null;
      overlay.hide();
      render();
    },
    onPick: (role) => startPicking(role),
    onPickCancel: () => stopPicking(),
  });

  // -------------------------------------------------------------------------------------------------------
  // The extension's own life: after an update or a reload of the extension, this script is cut off and stops

  function alive(): boolean {
    if (stopped) return false;
    if (chrome.runtime?.id) return true;
    stop();
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

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // the page does not allow the clipboard: the old way
      const area = document.createElement("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;left:-9999px;top:0";
      document.documentElement.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Per-conversation memory

  function chatOn(): boolean {
    return sessionStorage.getItem(`gmb-off:${page.chatKey()}`) !== "1";
  }

  function setChatOn(on: boolean): void {
    if (on) sessionStorage.removeItem(`gmb-off:${page.chatKey()}`);
    else sessionStorage.setItem(`gmb-off:${page.chatKey()}`, "1");
  }

  function active(): boolean {
    return !stopped && !!state?.enabled && chatOn();
  }

  const GIVEN_KEY = "given";

  async function givenHash(): Promise<string | null> {
    const key = page.givenKey();
    const onPage = page.instructionsOnPage();
    // the end of the last message sent still shown: the same conversation, its first turns dropped (a virtual list)
    const goesOn = !onPage && page.addressShared && page.sameConversation(location.href);
    if (key) {
      const all = ((await chrome.storage.local.get(GIVEN_KEY))[GIVEN_KEY] ?? {}) as Record<string, [string, number]>;
      if (all[key] && (onPage || goesOn || !page.addressShared)) return all[key][0];
    }
    if (goesOn && lastGiven) return lastGiven;
    if (!onPage) return null;
    // a new chat whose address was not known when its first message went out: those were the last instructions
    // this tab sent
    if (page.addressShared && lastGiven) return lastGiven;
    // instructions given elsewhere (another computer, before a reinstall): the hash is unknown
    return "?";
  }

  async function saveGiven(key: string, hash: string): Promise<void> {
    const all = ((await chrome.storage.local.get(GIVEN_KEY))[GIVEN_KEY] ?? {}) as Record<string, [string, number]>;
    all[key] = [hash, Date.now()];
    const entries = Object.entries(all)
      .sort((a, b) => b[1][1] - a[1][1])
      .slice(0, 500);
    await chrome.storage.local.set({ [GIVEN_KEY]: Object.fromEntries(entries) });
  }

  // -------------------------------------------------------------------------------------------------------
  // 1. Text in front of the user's message: the instructions, and results that waited

  function onUserSend(e: Event): void {
    // a script of the page can dispatch events too (and the extension's own send is a script click): only the
    // user's own count
    if (!e.isTrusted || !alive()) return;
    // the test message of the learning goes as the user sent it
    if (learner) return;
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
    if (passNext || (!pendingResults && (!state || state.tools.length === 0))) {
      // after a send of the extension's that did not go, the text is in the box as it was to go: the page sends it
      passNext = false;
      page.expect(page.editorText());
      return;
    }
    // what goes in front is decided asynchronously, so the send is held back and repeated
    e.preventDefault();
    e.stopImmediatePropagation();
    holding = true;
    void (async () => {
      let given: string | undefined;
      const along: ("instructions" | "update" | "results")[] = [];
      try {
        await freshState(FRESH_WAIT_MS);
        const parts: string[] = [];
        const cur = state;
        if (cur && cur.enabled && cur.tools.length) {
          const hash = toolsHash(cur.tools, cur.notes);
          const had = await givenHash();
          if (had !== hash) {
            parts.push(had === null ? buildInstructions(cur.tools, cur.notes) : buildToolsUpdate(cur.tools, cur.notes));
            along.push(had === null ? "instructions" : "update");
            given = hash;
          }
        }
        const results = pendingResults;
        if (results) {
          along.push("results");
          parts.push(results);
        }
        if (parts.length) {
          page.insertAtStart(`${parts.join("\n\n")}\n\n`);
          // an editor may turn the text down (or take it a moment later): then nothing went along, and results wait on
          const inBox = () => letters(page.editorText()).includes(letters(parts[0]).slice(0, 40));
          if (!inBox()) await sleep(200);
          if (inBox()) {
            if (results) {
              pendingResults = null;
              if (notice?.kind === "results") notice = null;
            }
          } else {
            dbg("the text did not go into the input box");
            given = undefined;
            along.length = 0;
            notice = { kind: "sendFailed", text: t("notInBox") };
          }
          render();
        }
        page.expect(page.editorText(), given);
      } catch (err) {
        // the user's message goes out in any case, as they wrote it
        dbg("could not prepare the message", err);
      }
      // still holding until the message is out: an Enter meanwhile would add the text a second time
      try {
        if (await page.submit()) {
          lastGiven = given ?? lastGiven;
          flow = { stage: "sent", at: Date.now(), with: along, wroteAt: 0 };
        } else if (alive()) {
          page.unexpect();
          // not again: what went in front is in the box already, and the user's next send goes as the page does it
          passNext = true;
          notice = { kind: "sendFailed", text: t("userSendFailed") };
        }
      } finally {
        holding = false;
        render();
      }
    })();
  }

  function onKeyDown(e: KeyboardEvent): void {
    // while picking, keys belong to the picker
    if (picker) return;
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || !e.isTrusted || fromUs(e)) return;
    // Enter picks from a list the box opened (a mention, a command): that is not a send
    const ed = editableOf(deepTarget(e));
    if (ed && (ed.getAttribute("aria-expanded") === "true" || ed.getAttribute("aria-activedescendant"))) return;
    if (page.isSendKey(e)) onUserSend(e);
  }

  function onClick(e: MouseEvent): void {
    if (!e.isTrusted || picker || fromUs(e)) return;
    if (page.isStopClick(e)) {
      userStopped = true;
      if (flow) flow = { stage: "stopped", at: Date.now() };
      return;
    }
    if (page.isSendClick(e)) onUserSend(e);
  }

  // -------------------------------------------------------------------------------------------------------
  // 2. Watching the replies

  function tick(): void {
    if (!alive()) return;
    if (page.address() !== lastAddress) onNavigate(lastAddress);
    else if (navCheck) {
      if (Date.now() > navCheck.until) navCheck = null;
      else if (!page.sameConversation(navCheck.from)) {
        dbg("another conversation after all");
        navCheck = null;
        leaveConversation();
      }
    }
    setTheme(pageIsDark());
    const finished = page.tick(active() && !learner, run !== null);
    if (flow?.stage === "sent" && page.progress()?.writing) flow.wroteAt = Date.now();
    if (flowText() !== lastFlowText) render();
    if (!finished) return;
    // the answer came: the instructions reached this conversation
    const key = page.givenKey();
    if (finished.given && key) void saveGiven(key, finished.given);
    void handleReply(finished);
  }

  function onNavigate(from: string): void {
    lastAddress = page.address();
    const was = page.chatKey(from);
    if (page.sameConversation(from)) {
      // a new chat got its address: its switch goes along
      if (sessionStorage.getItem(`gmb-off:${was}`) === "1") sessionStorage.setItem(`gmb-off:${page.chatKey()}`, "1");
      sessionStorage.removeItem(`gmb-off:${was}`);
      // a page may change the address first and draw the other conversation a moment later
      if (page.addressShared) navCheck = { from, until: Date.now() + NAV_RECHECK_MS };
    } else leaveConversation();
    render();
  }

  /** Another conversation: nothing of this one goes there. */
  function leaveConversation(): void {
    run?.abort();
    rounds = 0;
    notice = null;
    pendingResults = null;
    passNext = false;
    flow = null;
    page.otherConversation();
    sessionStorage.removeItem("gmb-off:new");
    render();
  }

  // -------------------------------------------------------------------------------------------------------
  // 3. Running the calls and sending the results

  async function handleReply(f: Finished): Promise<void> {
    if (!active() || userStopped) {
      if (flow?.stage !== "stopped") flow = null;
      render();
      return;
    }
    const items = f.items();
    dbg(
      "calls",
      items.map((it) => it.calls.map((c) => c.tool)),
      items.map((it) => it.problems),
    );
    if (!items.length) {
      flow = { stage: "done", at: Date.now() };
      render();
      return;
    }
    // the limit holds before anything runs: the calls of this reply wait for "Continue"
    if (rounds >= (state?.behavior.maxRounds ?? 20)) {
      flow = null;
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
            void handleReply(f);
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
      const total = Math.min(
        MAX_CALLS_PER_REPLY,
        items.reduce((n, it) => n + it.calls.length, 0),
      );
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
          outcomes.push(await runCall(call, rows[k], ctrl.signal, count, total));
        }
      }
      // the user went to another chat or turned the tools off: the results do not go anywhere
      if (ctrl.signal.aborted || !f.present()) return;
      await deliver(formatResults(outcomes, state?.behavior.maxResultChars ?? 20000));
    } finally {
      if (run === ctrl) run = null;
    }
  }

  function setFlow(f: Flow | null): void {
    flow = f;
    render();
  }

  async function runCall(call: ParsedCall, row: Row, signal: AbortSignal, i: number, n: number): Promise<Outcome> {
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
      setFlow({ stage: "asking", at: Date.now(), tool: call.tool, i, n });
      const decision = await row.ask(signal);
      if (decision === "deny") {
        row.set("denied");
        return { tool: call.tool, ok: false, text: signal.aborted ? "Not run: the user left the conversation or turned the tools off." : "The user declined this call." };
      }
      if (decision === "always") {
        known.policy = "auto";
        void send({ type: "allowHere", tool: known.name });
      }
      approved = true;
      return null;
    };
    if (known.policy !== "auto") {
      const refused = await ask();
      if (refused) return refused;
    }
    row.set("running");
    setFlow({ stage: "running", at: Date.now(), tool: call.tool, i, n });
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
    const draft = page.editorText();
    flow = null;
    if (state && !state.behavior.autoSend) {
      page.replaceText(draft ? `${message}\n\n${draft}` : message);
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
            void sendNow(waiting, page.editorText());
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
    setFlow({ stage: "sending", at: Date.now() });
    const text = draft ? `${message}\n\n${draft}` : message;
    page.replaceText(text);
    rounds++;
    page.expect(text);
    // an Enter of the user's meanwhile would send a second time
    holding = true;
    let ok = false;
    try {
      ok = await page.submit();
    } finally {
      holding = false;
    }
    if (!alive()) return;
    dbg("results sent", ok);
    if (ok) flow = { stage: "sent", at: Date.now(), with: ["results"], wroteAt: 0 };
    else {
      flow = null;
      page.unexpect();
      notice = { kind: "sendFailed", text: t("sendFailed") };
    }
    render();
  }

  // -------------------------------------------------------------------------------------------------------
  // The status line: where the last exchange stands

  function flowView(): FlowView | null {
    const f = flow;
    if (!f || !active() || learner) return null;
    const now = Date.now();
    switch (f.stage) {
      case "sent": {
        const p = page.progress();
        // the page no longer waits (the answer took too long to start)
        if (!p && now - f.at > 2500) return null;
        const notes: string[] = [];
        const what = f.with.map((w) => t(w === "instructions" ? "withInstructions" : w === "update" ? "withUpdate" : "withResults"));
        if (what.length) notes.push(t("flowSentWith", { s: what.join(", ") }));
        if (p?.how === "guessed") notes.push(layout ? t("flowLearnedMissing") : t("flowGuessing"));
        if (!p) return { text: t("flowSent"), tone: "busy", notes };
        if (p.writing) return { text: t("flowWriting"), tone: "busy", notes };
        if (p.replySeen && p.calls) return { text: t("flowReplyCalls", { n: p.calls }), tone: "busy", notes };
        if (p.replySeen) return { text: t("flowReplyEnd"), tone: "busy", notes };
        const stuck = now - f.at > STUCK_MS || (f.wroteAt > 0 && now - f.wroteAt > STUCK_AFTER_WRITING_MS);
        if (!stuck) return { text: t("flowWaiting"), tone: "busy", notes };
        const actions: FlowView["actions"] = [];
        if (page.kind === "generic") actions.push({ label: layout ? t("learnAgain") : t("learnStart"), run: () => startLearning() });
        const copiedNow = now - copiedAt < 2500;
        actions.push({
          label: copiedNow ? (copiedOk ? `✓ ${t("copied")}` : t("copyFailed")) : t("copyStructure"),
          run: () =>
            void copy(pageStructure()).then((ok) => {
              copiedAt = Date.now();
              copiedOk = ok;
              render();
            }),
        });
        return { text: t("flowStuck"), tone: "warn", notes: [page.kind === "generic" ? t("flowStuckHint") : t("flowStuckHintKnown")], actions };
      }
      case "asking":
        return { text: t("flowAsking", { tool: f.tool }), tone: "warn" };
      case "running":
        return { text: t("flowRunning", { tool: f.tool, i: f.i, n: f.n }), tone: "busy" };
      case "sending":
        return { text: t("flowSending"), tone: "busy" };
      case "done":
        return now - f.at < FLOW_SHOWN_MS ? { text: t("flowDone"), tone: "ok" } : null;
      case "stopped":
        return now - f.at < FLOW_SHOWN_MS ? { text: t("flowStopped"), tone: "ok" } : null;
    }
  }

  function flowText(v = flowView()): string {
    return v ? `${v.tone}|${v.text}|${v.notes?.join("|") ?? ""}|${v.actions?.map((a) => a.label).join("|") ?? ""}` : "";
  }

  // -------------------------------------------------------------------------------------------------------
  // Learning the page (generic mode)

  function startLearning(): void {
    if (page.kind !== "generic" || stopped) return;
    stopPicking();
    results = null;
    overlay.hide();
    learner?.cancel();
    learner = new Learner(render);
    pill.close();
    dbg("learning", learner.nonce);
    render();
  }

  function stopLearning(): void {
    if (!learner) return;
    const r = learner.stop();
    learner = null;
    results = { roles: r.roles, saved: !!r.layout };
    dbg("learned", r.layout, r.roles.map((x) => `${x.role}:${x.found}`));
    const learned = r.layout;
    if (learned) {
      setLayout(learned);
      overlay.show(() => outlineItems(learned));
      void saveLayout(learned).catch((err) => dbg("could not keep the layout", err));
    }
    render();
  }

  function showLearned(): void {
    const l = layout;
    if (!l) return;
    learner?.cancel();
    learner = null;
    results = { roles: checkLayout(l), saved: true };
    overlay.show(() => outlineItems(l));
    render();
  }

  function startPicking(role: Role): void {
    if (page.kind !== "generic" || stopped) return;
    picker?.close();
    picking = { role, current: "" };
    picker = new Picker(
      role,
      (el) => {
        if (picking) picking.current = short(el);
        render();
      },
      (el) => {
        picker = null;
        picking = null;
        if (el) applyPick(role, el);
        render();
      },
    );
    render();
  }

  function stopPicking(): void {
    picker?.close();
    picker = null;
    picking = null;
    render();
  }

  /** The part the user picked goes into the layout of the site, and the list and outlines show it. */
  function applyPick(role: Role, el: Element): void {
    const r = withPicked(layout, role, el);
    if ("error" in r) {
      results = { roles: results?.roles ?? (layout ? checkLayout(layout) : []), saved: !!layout, message: r.error };
      return;
    }
    const l = r.layout;
    setLayout(l);
    void saveLayout(l).catch((err) => dbg("could not keep the layout", err));
    results = { roles: checkLayout(l), saved: true };
    overlay.show(() => outlineItems(l));
    dbg("picked", role, l);
  }

  function learnBox(): LearnBox | null {
    if (learner) return { kind: "learning", view: learner.view() };
    if (picking) return { kind: "picking", role: picking.role, current: picking.current };
    if (!results) return null;
    return {
      kind: "results",
      saved: results.saved,
      message: results.message,
      roles: results.roles.map((r) => ({ role: r.role, found: r.found, detail: short(r.el), note: r.note })),
    };
  }

  // -------------------------------------------------------------------------------------------------------

  function render(): void {
    if (stopped) return;
    const flowNow = flowView();
    lastFlowText = flowText(flowNow);
    pill.render({
      state,
      chatOn: chatOn(),
      notice,
      site: page.kind === "generic" ? { learned: layout?.at ?? null } : null,
      learn: learnBox(),
      flow: flowNow,
      avoid: () => inputAreaRects(learner?.inputArea() ?? page.inputArea()),
    });
  }

  function setLayout(l: Layout | null): void {
    layout = l;
    page.useLayout?.(l);
  }

  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    // the service worker reconnects changed servers by itself: no need to list every server again
    if (changes.settings) void refreshState(false);
    // learned in another tab of the site, or forgotten on the options page
    const l = page.kind === "generic" ? layoutChange(changes) : undefined;
    if (l !== undefined) {
      setLayout(l);
      render();
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void freshState();
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onClick, true);
    document.removeEventListener("visibilitychange", onVisible);
    try {
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      // the extension is gone already
    }
    run?.abort();
    learner?.cancel();
    learner = null;
    picker?.close();
    picker = null;
    overlay.hide();
    page.stop();
    pill.host.remove();
    removePageStyle();
    dbg("stopped");
  }

  installPageStyle();
  setTheme(pageIsDark());
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onClick, true);
  chrome.storage.onChanged.addListener(onStorage);
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(tick, TICK_MS);
  void refreshState();
  if (page.kind === "generic")
    void loadLayout().then((l) => {
      setLayout(l);
      render();
    });
  render();
  dbg("started", page.kind);
  return stop;
}
