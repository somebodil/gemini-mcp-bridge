// The bridge on a chat page, whatever the site (the Page says how to find things on it). It
//  1. puts the tool instructions in front of the first message the user sends in a conversation,
//  2. waits until the reply to that message is finished, reads the tool calls in it and runs them (asking
//     first unless the tool may run by itself),
//  3. sends the results back as the next message, and goes on until the reply has no call.

import type { BridgeState, CallReply, ExposedTool, Request } from "../shared/config.ts";
import { t } from "../shared/i18n.ts";
import { buildInstructions, buildToolsUpdate, formatResults, toolsHash, type Outcome, type ParsedCall } from "../shared/protocol.ts";
import { noSuchTool } from "../shared/tools.ts";
import { layoutChange, loadLayout, saveLayout, type Layout } from "./layout.ts";
import { checkLayout, Learner, outlineItems, type RoleResult } from "./learn.ts";
import { Overlay } from "./overlay.ts";
import { dbg, describe, pageStructure, type Finished, type Page } from "./page.ts";
import { installPageStyle, pageIsDark, Pill, removePageStyle, setTheme, type LearnBox, type Notice, type Row } from "./ui.ts";

const MAX_CALLS_PER_REPLY = 10;
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
  /** What it learned, shown until the user closes it. */
  let results: { roles: RoleResult[]; saved: boolean } | null = null;
  const overlay = new Overlay();

  const pill = new Pill({
    generic: page.kind === "generic",
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
    if (key) {
      const all = ((await chrome.storage.local.get(GIVEN_KEY))[GIVEN_KEY] ?? {}) as Record<string, [string, number]>;
      if (all[key] && (onPage || !page.addressShared)) return all[key][0];
    }
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
    if (!pendingResults && (!state || state.tools.length === 0)) {
      page.expect(page.editorText());
      return;
    }
    // what goes in front is decided asynchronously, so the send is held back and repeated
    e.preventDefault();
    e.stopImmediatePropagation();
    holding = true;
    void (async () => {
      let given: string | undefined;
      try {
        await freshState(FRESH_WAIT_MS);
        const parts: string[] = [];
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
        if (parts.length) page.insertAtStart(`${parts.join("\n\n")}\n\n`);
        page.expect(page.editorText(), given);
      } catch (err) {
        // the user's message goes out in any case, as they wrote it
        dbg("could not prepare the message", err);
      }
      // still holding until the message is out: an Enter meanwhile would add the text a second time
      try {
        if (await page.submit()) lastGiven = given ?? lastGiven;
        else page.unexpect();
      } finally {
        holding = false;
        render();
      }
    })();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || !e.isTrusted) return;
    if (page.isSendKey(e)) onUserSend(e);
  }

  function onClick(e: MouseEvent): void {
    if (!e.isTrusted) return;
    if (page.isStopClick(e)) {
      userStopped = true;
      return;
    }
    if (page.isSendClick(e)) onUserSend(e);
  }

  // -------------------------------------------------------------------------------------------------------
  // 2. Watching the replies

  function tick(): void {
    if (!alive()) return;
    if (page.address() !== lastAddress) onNavigate(lastAddress);
    setTheme(pageIsDark());
    const finished = page.tick(active() && !learner, run !== null);
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
    } else {
      // another conversation: nothing of this one goes there
      run?.abort();
      rounds = 0;
      notice = null;
      pendingResults = null;
      page.otherConversation();
      sessionStorage.removeItem("gmb-off:new");
    }
    render();
  }

  // -------------------------------------------------------------------------------------------------------
  // 3. Running the calls and sending the results

  async function handleReply(f: Finished): Promise<void> {
    if (!active() || userStopped) return;
    const items = f.items();
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
      if (ctrl.signal.aborted || !f.present()) return;
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
    const draft = page.editorText();
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
    const text = draft ? `${message}\n\n${draft}` : message;
    page.replaceText(text);
    rounds++;
    page.expect(text);
    const ok = await page.submit();
    dbg("results sent", ok);
    if (!ok) {
      page.unexpect();
      notice = { kind: "sendFailed", text: t("sendFailed") };
    }
    render();
  }

  // -------------------------------------------------------------------------------------------------------
  // Learning the page (generic mode)

  function startLearning(): void {
    if (page.kind !== "generic" || stopped) return;
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
      layout = learned;
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

  function learnBox(): LearnBox | null {
    if (learner) return { kind: "learning", view: learner.view() };
    if (!results) return null;
    return {
      kind: "results",
      saved: results.saved,
      roles: results.roles.map((r) => ({ role: r.role, found: r.found, detail: r.el ? describe(r.el).slice(0, 80) : "", note: r.note })),
    };
  }

  // -------------------------------------------------------------------------------------------------------

  function render(): void {
    if (!stopped) pill.render({ state, chatOn: chatOn(), notice, site: page.kind === "generic" ? { learned: layout?.at ?? null } : null, learn: learnBox() });
  }

  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    // the service worker reconnects changed servers by itself: no need to list every server again
    if (changes.settings) void refreshState(false);
    // learned in another tab of the site, or forgotten on the options page
    const l = page.kind === "generic" ? layoutChange(changes) : undefined;
    if (l !== undefined) {
      layout = l;
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
      layout = l;
      render();
    });
  render();
  dbg("started", page.kind);
  return stop;
}
