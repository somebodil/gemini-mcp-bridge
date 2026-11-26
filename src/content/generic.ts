// Any chat page other than gemini.google.com (Gemini Enterprise, and others like it), whose elements the
// extension does not know. It goes by what every chat page has:
//  - the input box is the box the user types in (a textarea, or an element one can write in),
//  - the send and stop buttons are told by their names (aria-label, title, icon name),
//  - a call is a code block that turned up after the message went out, also inside shadow roots.
//
// Which blocks are the answer: when a message goes out, the extension counts the call blocks on the page by their
// text and notes the last code block; a block counts as new only when it comes after that one and its text is
// on the page more often than before. Blocks that are in the message itself (the example in the instructions)
// never count. A page that draws its messages anew, or older messages that load while scrolling up, add no new
// blocks. When the address changes, the conversation is the same while the page still shows the message that
// went out (a new chat may get its address only as its answer is written); otherwise the other chat's blocks
// count as there before.
//
// Once the user taught the extension the page (learn.ts), it goes by what it learned where the page has it: the
// learned input box, send button and writing indicator, and the answer is the learned kind of reply right after
// the user's message that holds the end of what went out; only the code blocks in it count. Where the learned
// elements are not on the page (the page changed), it guesses as above.

import { CALL_KEY, looksLikeCall, MARK, parseCalls } from "../shared/protocol.ts";
import { busyNow, contains, deepText, findAll, letters, matchesPattern, resolve, textNodesWith, type Layout } from "./layout.ts";
import {
  buttonOf,
  caretToStart,
  codeText,
  composerRect,
  dbg,
  deepElements,
  deepTarget,
  editableOf,
  isButtonish,
  isMonospace,
  isOurs,
  nameOf,
  parentOf,
  SEND,
  selectAllIn,
  shadowOf,
  sleep,
  treesUnder,
  STOP,
  typeText,
  usable,
  valueOf,
  type Finished,
  type Item,
  type Page,
  type Progress,
} from "./page.ts";
import { timed } from "./perf.ts";
import { Card } from "./ui.ts";

/** A reply's blocks unchanged this long (and the page not writing): the reply is finished. */
const STABLE_MS = 2000;
/** The same for a block that cannot be read yet: it may be cut off while the page still writes. */
const UNREADABLE_STABLE_MS = 6000;
/** Past this, a stop button that never goes away (a wrong guess) does not hold the reply back. */
const GENERATING_MAX_MS = 20_000;
const EXPECT_MAX_MS = 5 * 60_000;
/** A learned reply without a call and without a learned writing indicator: finished when it stood still this long. */
const NO_INDICATOR_STABLE_MS = 6000;
/** A reply taken as finished without a call is watched this much longer: the page may only have paused in it. */
const LATE_CALL_MS = 90_000;

const squash = (s: string) => s.replace(/\s+/g, "");
/** The text of the whole page, shadow roots included. */
function pageText(): string {
  const parts: string[] = [];
  for (const tree of treesUnder(document.body ?? document.documentElement)) parts.push(tree.textContent ?? "");
  return parts.join(" ");
}

/** Where text is not a message: the page's code, and its menus (a chat list names chats by their first message). */
const NOT_MESSAGES = "script, style, noscript, template, title, nav, aside, a, [role=navigation], [role=menu], [role=listbox]";
/** Text in a message of the conversation: not in NOT_MESSAGES (looked for up to the shadow root it is in). */
function inMessage(n: Node): boolean {
  return !n.parentElement?.closest(NOT_MESSAGES);
}

/** The calls a block holds, as one string to compare. */
const callsOf = (text: string) => JSON.stringify(parseCalls([text]).calls.map((c) => [c.tool, c.arguments]));

/** Inside these nothing is a button of the input box: code, icons, and what a native button holds. */
const PRUNE_BUTTONS = new Set(["pre", "svg", "button", "select", "textarea"]);
/**
 * Where the buttons of the input box are: the box around it with its buttons, and a strip above it (a stop button
 * may float over the box). A list of chats beside it is not there, however close.
 */
function buttonZone(ed: Element): { left: number; right: number; top: number; bottom: number } {
  const c = composerRect(ed);
  return { left: c.left - 16, right: c.right + 16, top: c.top - 120, bottom: c.bottom + 16 };
}
const inZone = (r: DOMRect, z: ReturnType<typeof buttonZone>) => r.right > z.left && r.left < z.right && r.bottom > z.top && r.top < z.bottom;

/** Buttons named with "send" that send something else than the message. */
const NOT_THE_MESSAGE = /feedback|report|share|invite|survey|e-?mail|sms|피드백|신고|공유|초대|의견/i;
/** A send button called just that. */
const JUST_SEND = /^\s*(send|submit|send message|send prompt|보내기|전송|제출|메시지 보내기)\s*$/i;

/**
 * A usable button named like `re` near `from`: in its parent, else its grandparent, and so on. For the send
 * button, one called just "Send" goes before one that only has the word in its name, and "Send feedback" and the
 * like are never it.
 */
function buttonNear(from: Element, re: RegExp, not?: RegExp): HTMLElement | null {
  const sending = re === SEND;
  const zone = buttonZone(from);
  let fallback: HTMLElement | null = null;
  let scope: Element | null = from;
  let inner: Element | undefined;
  for (let level = 0; scope && level < 10; level++, inner = scope, scope = parentOf(scope)) {
    // each step looks only at what the last one did not
    for (const el of deepElements(scope, inner, (e) => PRUNE_BUTTONS.has(e.localName))) {
      if (!(el instanceof HTMLElement) || !isButtonish(el)) continue;
      // a custom button element takes clicks on its inner <button>: the inner one is the one to press
      if (shadowOf(el)?.querySelector("button")) continue;
      const name = nameOf(el);
      if (!re.test(name) || (not && not.test(name)) || !usable(el)) continue;
      if (!inZone(el.getBoundingClientRect(), zone)) continue;
      if (!sending) return el;
      if (NOT_THE_MESSAGE.test(name)) continue;
      if (JUST_SEND.test(name)) return el;
      fallback ??= el;
    }
  }
  return fallback;
}

/** Enter as a script presses it (many editors take only the user's own keys); with Ctrl where the page wants it. */
function pressEnter(ed: HTMLElement, mod = false): void {
  for (const type of ["keydown", "keypress", "keyup"]) {
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: mod, bubbles: true, cancelable: true, composed: true };
    ed.dispatchEvent(new KeyboardEvent(type, init));
  }
}

interface Block {
  el: HTMLElement;
  text: string;
}

/** Not shown: a copy of the text kept for copying or for screen readers (a call there is not a second call). */
function hidden(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) return true;
  return !el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

/** The text of a code block; of a call, as copying it gives (no Copy button, no line numbers). */
function blockText(el: Element, text = deepText(el)): string {
  return looksLikeCall(text) ? codeText(el) : text;
}

/**
 * Code blocks under `root` (the page) in document order: <pre>, and <code> of more than one line outside one.
 * Where none holds a call but a call is on the page: the monospace boxes around it (a page that draws code
 * blocks without <pre> and <code>).
 */
function codeBlocks(root: Element = document.body ?? document.documentElement): Block[] {
  const out: Block[] = [];
  for (const el of deepElements(root, undefined, (e) => e.localName === "pre")) {
    if (el.localName !== "pre" && el.localName !== "code") continue;
    if (el.localName === "code" && el.closest("pre")) continue;
    const text = el.textContent ?? "";
    if (el.localName === "code" && !text.includes("\n")) continue;
    if (looksLikeCall(text) && hidden(el)) continue;
    out.push({ el: el as HTMLElement, text: blockText(el, text) });
  }
  if (out.some((b) => looksLikeCall(b.text))) return out;
  const boxes = new Set<Element>();
  for (const n of textNodesWith(root, CALL_KEY)) {
    let box: Element | null = null;
    for (let a = n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null); a && a !== root; a = parentOf(a)) {
      if (isOurs(a) || a.localName === "pre" || a.localName === "code") {
        box = null;
        break;
      }
      if (isMonospace(a)) box = a;
      else if (box) break;
    }
    if (box) boxes.add(box);
  }
  if (!boxes.size) return out;
  const extra = [...boxes].map((el) => ({ el: el as HTMLElement, text: blockText(el) }));
  return [...out, ...extra].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

interface Expect {
  /** Call blocks on the page by text, and how many of each. */
  before: Map<string, number>;
  /** The last code block on the page: the answer's blocks come after it. */
  last: Element | null;
  /** The message as sent, without whitespace: blocks inside it are not the answer. */
  sent: string;
  at: number;
  sawGenerating: boolean;
  given?: string;
  /** The user's messages of the learned kind on the page when it went out, and how many. */
  mineBefore: WeakSet<Element>;
  mineCount: number;
  /** The end of the message as written (its last line), to tell where on the page the message ends. */
  end: string;
  /** How often the end of the message was on the page (the input box included) when it went out. */
  tailCount: number;
  /** Since when the end of the message is not on the page after the address changed (0: it is). */
  away: number;
}

/** The message not seen again this long after the address changed: it went to another conversation. */
const AWAY_MS = 15_000;
const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

export class GenericPage implements Page {
  readonly kind = "generic";
  readonly addressShared = true;
  private ed: HTMLElement | null = null;
  private expecting: Expect | null = null;
  /** Counts the stops: a send still trying when the extension was turned off gives up. */
  private gen = 0;
  /** The last message's reply, taken as finished without a call: watched a while longer (lookLate). */
  private after: { e: Expect; until: number } | null = null;
  /** The end of the last message that went out, letters and digits only: while the page shows it, the conversation is the same. */
  private lastTail = "";
  /**
   * The ends of the last messages that went out in this conversation: while the page shows one of them, the
   * conversation is the same (a virtual list keeps only the last turns, and a short message alone tells little).
   */
  private tails: string[] = [];
  private latest = { sig: "", since: 0 };
  /** When the page began to show its stop button, and when it was last seen: 0 while it is not shown. */
  private generatingSince = 0;
  private generatingAt = 0;
  private readonly cards = new Map<Element, Card>();
  private layout: Layout | null = null;
  private prog: Progress | null = null;

  constructor() {
    window.addEventListener("focusin", this.onFocus, true);
  }

  private readonly onFocus = timed("focusin", (e: FocusEvent) => {
    const ed = editableOf(deepTarget(e));
    if (ed && this.mayBeTheBox(ed)) this.ed = ed;
  });

  /**
   * The chat's input box can be `ed`: the learned one (or in it) where the page has it; else not a search field,
   * not in a menu, and not a document as tall as the page (an editor beside the chat).
   */
  private mayBeTheBox(ed: HTMLElement): boolean {
    const learned = resolve(this.layout?.input);
    if (learned?.isConnected) return contains(learned, ed) || contains(ed, learned);
    if (ed instanceof HTMLInputElement && ed.type === "search") return false;
    if (/^(combobox|searchbox)$/.test(ed.getAttribute("role") ?? "") || ed.closest("[role=search], nav, [role=navigation], [role=menu]")) return false;
    return ed.getBoundingClientRect().height <= innerHeight * 0.6;
  }

  useLayout(layout: Layout | null): void {
    this.layout = layout;
  }

  progress(): Progress | null {
    return this.prog;
  }

  inputArea(): Element[] {
    const ed = this.editor();
    if (!ed) return [];
    const send = resolve(this.layout?.send) ?? buttonNear(ed, SEND, STOP);
    return send ? [ed, send] : [ed];
  }

  /** The input box: the one the user wrote in last, else the learned one, else the last one on the page that one can write in. */
  private editor(): HTMLElement | null {
    // a box hidden or taken away (the page made a new one) is not it any more
    if (this.ed?.isConnected && this.ed.getClientRects().length) return this.ed;
    const learned = resolve(this.layout?.input);
    const box = learned ? editableOf(learned) : null;
    if (box?.getClientRects().length) return (this.ed = box);
    let found: HTMLElement | null = null;
    for (const el of deepElements(document.body ?? document.documentElement)) {
      const box = el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable && !el.parentElement?.isContentEditable);
      const ed = box ? editableOf(el) : null;
      if (ed && ed.getClientRects().length && this.mayBeTheBox(ed)) found = ed;
    }
    this.ed = found;
    return found;
  }

  editorText(): string {
    const ed = this.editor();
    return ed ? valueOf(ed) : "";
  }

  insertAtStart(text: string): boolean {
    const ed = this.editor();
    if (!ed) return false;
    ed.focus();
    caretToStart(ed);
    return typeText(ed, text);
  }

  replaceText(text: string): boolean {
    const ed = this.editor();
    if (!ed) return false;
    ed.focus();
    selectAllIn(ed);
    return typeText(ed, text);
  }

  /** Presses the send button next to the input box; without one, or when it did nothing, Enter in the box. */
  async submit(timeoutMs = 8000): Promise<boolean> {
    // the page's editor may take the new text into its own state a moment later
    await sleep(300);
    const ed = this.editor();
    if (!ed) return false;
    const gen = this.gen;
    const start = Date.now();
    // a page learned to send with Ctrl+Enter: the keys the user presses there, before any button
    const keysFirst = this.layout?.sendKey === "mod";
    let clickedAt = 0;
    let enteredAt = 0;
    let modTried = keysFirst;
    let reclicked = false;
    // a page may make a new input box once the message is out
    const went = () => {
      const now = ed.isConnected ? ed : this.editor();
      return !now || valueOf(now) === "" || this.isGenerating();
    };
    // asked before trying again (it reads the page): a page may clear its box only once its server answered,
    // and then the message on the page tells
    const out = () => went() || this.appeared();
    while (Date.now() - start < timeoutMs) {
      if (gen !== this.gen) return false;
      const now = Date.now();
      if ((clickedAt || enteredAt) && went()) return true;
      if (!clickedAt && !keysFirst) {
        const b = this.sendButton(ed);
        if (b) {
          b.click();
          clickedAt = now;
        }
      } else if (enteredAt && !reclicked && now - (clickedAt || enteredAt) > 4000) {
        // neither the click nor the keys were taken (a dialog came up over the page then): one more click
        if (out()) return true;
        const b = this.sendButton(ed);
        if (b) b.click();
        reclicked = true;
      }
      // Enter when there is no send button, or when the click did nothing (the button is still there, ready):
      // never after a click the page took
      const pressNow = keysFirst || (clickedAt ? now - clickedAt > 1500 && this.sendButton(ed) !== null : now - start > 1000);
      if (!enteredAt && pressNow) {
        if (clickedAt && out()) return true;
        ed.focus();
        pressEnter(ed, modTried);
        enteredAt = now;
      } else if (enteredAt && !modTried && now - enteredAt > 2500 && valueOf(ed) !== "") {
        // Enter alone did nothing (the box still full, not writing): some pages send with Ctrl+Enter.
        // A synthetic Enter adds no new line, so the text goes as it was.
        if (out()) return true;
        ed.focus();
        pressEnter(ed, true);
        modTried = true;
      }
      await sleep(100);
    }
    return out();
  }

  /** The message is on the page now (in a message, not only in the input box). */
  private appeared(): boolean {
    const e = this.expecting;
    if (!e) return false;
    if (this.layout?.mine) return this.turns().some((x) => x.mine && !e.mineBefore.has(x.el) && letters(deepText(x.el)).includes(this.lastTail));
    return count(letters(pageText()), this.lastTail) > e.tailCount;
  }

  isSendKey(e: KeyboardEvent): boolean {
    // a page that sends with Ctrl+Enter makes a new line with Enter alone
    if (this.layout?.sendKey === "mod" && !e.ctrlKey && !e.metaKey) return false;
    const ed = editableOf(deepTarget(e));
    if (!ed || !this.mayBeTheBox(ed)) return false;
    this.ed = ed;
    return valueOf(ed) !== "";
  }

  /** The send button: the learned one (while it sends), else one named like it near the input box. */
  private sendButton(ed: HTMLElement): HTMLElement | null {
    const learned = resolve(this.layout?.send);
    if (learned instanceof HTMLElement) return usable(learned) && !this.isGenerating() ? learned : null;
    return buttonNear(ed, SEND, STOP);
  }

  /** The click went to `learned` (or to the button around it). */
  private clickedOn(e: MouseEvent, learned: Element | null): boolean {
    if (!learned) return false;
    const b = buttonOf(e);
    const target = b ?? deepTarget(e);
    return !!target && (contains(learned, target) || (!!b && contains(b, learned)));
  }

  isSendClick(e: MouseEvent): boolean {
    if (this.editorText() === "") return false;
    if (this.clickedOn(e, resolve(this.layout?.send)) && !this.isGenerating()) return true;
    const b = buttonOf(e);
    if (!b) return false;
    const name = nameOf(b);
    return SEND.test(name) && !STOP.test(name);
  }

  isStopClick(e: MouseEvent): boolean {
    const l = this.layout;
    if ((this.clickedOn(e, resolve(l?.busy?.at)) || this.clickedOn(e, resolve(l?.send))) && this.isGenerating()) return true;
    const b = buttonOf(e);
    return !!b && STOP.test(nameOf(b));
  }

  /** By the learned writing indicator where the page has it; else a stop button near the input box. */
  private isGenerating(): boolean {
    const learned = busyNow(this.layout?.busy);
    if (learned !== undefined) return learned;
    const ed = this.editor();
    return !!ed && buttonNear(ed, STOP) !== null;
  }

  address(): string {
    return location.pathname + location.search;
  }

  chatKey(address = this.address()): string {
    return address;
  }

  /**
   * A new chat often gets its address only once the answer is being written; another chat opened from the list
   * changes the address too. The same conversation still shows the message that went out.
   */
  sameConversation(): boolean {
    const known = this.tails.filter((t) => t.length >= 8);
    if (!known.length) return false;
    const text = letters(pageText());
    return known.some((t) => text.includes(t));
  }

  givenKey(): string | null {
    return location.host + this.address();
  }

  /** The instructions in a message of the conversation (not in a chat list that names chats by their first message). */
  instructionsOnPage(): boolean {
    const root = resolve(this.layout?.list) ?? document.body ?? document.documentElement;
    return textNodesWith(root, MARK.instructions).some(inMessage);
  }

  expect(text: string, given?: string): void {
    this.after = null;
    const mine = this.turns().flatMap((x) => (x.mine ? [x.el] : []));
    this.lastTail = letters(text).slice(-60);
    this.tails = [...this.tails.slice(-2), this.lastTail];
    const end = (text.trim().split("\n").at(-1) ?? "").trim().slice(-40);
    this.expecting = {
      ...this.baseline(),
      sent: squash(text),
      at: Date.now(),
      sawGenerating: false,
      given,
      mineBefore: new WeakSet(mine),
      mineCount: mine.length,
      end,
      tailCount: this.layout?.mine ? 0 : count(letters(pageText()), this.lastTail),
      away: 0,
    };
    this.latest = { sig: "", since: Date.now() };
    dbg("expecting", this.expecting.before.size, this.expecting.last?.localName);
  }

  unexpect(): void {
    this.expecting = null;
    this.prog = null;
  }

  /** The user's messages and the replies in the list, in page order, by the learned kinds; none when not learned. */
  private turns(): { mine: boolean; el: Element }[] {
    const l = this.layout;
    if (!l?.reply) return [];
    const out: { mine: boolean; el: Element }[] = [];
    // the outermost ones only: nothing under one found is looked at
    for (const el of deepElements(resolve(l.list) ?? document.body ?? document.documentElement, undefined, (e) => e === out.at(-1)?.el)) {
      const mine = !!l.mine && matchesPattern(el, l.mine);
      if (mine || matchesPattern(el, l.reply)) out.push({ mine, el });
    }
    return out;
  }

  /**
   * The answer by the learned kinds: the reply right after the user's message that holds the end of what went
   * out (else after a message that came after the ones there were). `learned` is false where the page has none of
   * the learned kinds (then the extension guesses).
   */
  private awaitedByLayout(e: Expect): { learned: boolean; reply: Element | null } {
    const turns = this.turns();
    if (!turns.length) return { learned: false, reply: null };
    // a message there before the send is not it (the same short message sent twice), unless the page draws its
    // messages anew (then there are more of them now)
    const mine = turns.flatMap((x, i) => (x.mine ? [i] : []));
    const more = mine.length > e.mineCount;
    const isNew = (i: number) => !e.mineBefore.has(turns[i].el) || more;
    let at = -1;
    for (let i = turns.length - 1; i >= 0 && at < 0; i--) if (turns[i].mine && isNew(i) && letters(deepText(turns[i].el)).includes(this.lastTail)) at = i;
    if (at < 0 && more && !e.mineBefore.has(turns[mine.at(-1) as number].el)) at = mine.at(-1) as number;
    const next = at >= 0 ? turns[at + 1] : undefined;
    return { learned: true, reply: next && !next.mine ? next.el : null };
  }

  /** The code blocks of a reply: of the learned kind, else <pre> and <code> of more than one line. */
  private blocksIn(reply: Element): Block[] {
    const kind = this.layout?.code;
    if (!kind) return codeBlocks(reply);
    return findAll(kind, reply).map((el) => ({ el: el as HTMLElement, text: blockText(el) }));
  }

  /** What is on the page now: none of it is the answer. */
  private baseline(): Pick<Expect, "before" | "last"> {
    const before = new Map<string, number>();
    const all = codeBlocks();
    for (const b of all) if (looksLikeCall(b.text)) before.set(squash(b.text), (before.get(squash(b.text)) ?? 0) + 1);
    return { before, last: all.at(-1)?.el ?? null };
  }

  /** The call blocks that turned up since the message went out. */
  private fresh(e: Expect): Block[] {
    const seen = new Map<string, number>();
    const out: Block[] = [];
    // the last block of before may have been drawn anew: then only the counts tell
    let after = !e.last?.isConnected;
    let end: Node | null | undefined;
    for (const b of codeBlocks()) {
      if (b.el === e.last) {
        after = true;
        continue;
      }
      if (!looksLikeCall(b.text)) continue;
      const key = squash(b.text);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (!after || n <= (e.before.get(key) ?? 0)) continue;
      if (e.sent.includes(key)) {
        // the same text as in the message (its example): not an answer where it is in the message, before its end
        end ??= e.end ? (textNodesWith(document.body ?? document.documentElement, e.end).filter(inMessage).at(-1) ?? null) : null;
        if (!end || b.el.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
      }
      out.push(b);
    }
    return out;
  }

  /**
   * A reply taken as finished without a call (it stood still) may have only paused: a call that turns up in it
   * afterwards is waited for as if the reply had not finished.
   */
  private lookLate(): void {
    const a = this.after;
    if (!a) return;
    if (Date.now() > a.until) {
      this.after = null;
      return;
    }
    const byLayout = this.awaitedByLayout(a.e);
    const reply = byLayout.reply;
    const blocks = byLayout.learned ? (reply ? this.blocksIn(reply).filter((b) => looksLikeCall(b.text)) : []) : this.fresh(a.e);
    if (!blocks.length) return;
    dbg("a call after the reply looked finished");
    this.after = null;
    this.expecting = { ...a.e, sawGenerating: false };
    this.latest = { sig: "", since: Date.now() };
  }

  tick(active: boolean, busy: boolean): Finished | null {
    if (this.cards.size) this.keepCards(busy);
    if (!this.expecting && this.after && active && !busy) this.lookLate();
    const e = this.expecting;
    if (!e || !active) {
      this.prog = null;
      return null;
    }
    const now = Date.now();
    if (e.away) {
      // the address changed and the message is not on the page: nothing here is its answer, unless it shows up
      // (a new chat that got its address before it drew the message)
      if (this.sameConversation()) e.away = 0;
      else {
        if (now - e.away > AWAY_MS) {
          dbg("the message went to another conversation");
          this.expecting = null;
        }
        this.prog = null;
        return null;
      }
    }
    const generating = this.isGenerating();
    if (generating) {
      e.sawGenerating = true;
      this.generatingSince ||= now;
    } else this.generatingSince = 0;
    // a stop button shown longer than this is a wrong guess (or one the page never takes away): no longer heeded
    const writing = generating && now - this.generatingSince < GENERATING_MAX_MS;
    if (writing) this.generatingAt = now;
    const byLayout = this.awaitedByLayout(e);
    const reply = byLayout.reply;
    // in the learned reply every call block is the answer's (the message's own blocks are in the message)
    const blocks = byLayout.learned ? (reply ? this.blocksIn(reply).filter((b) => looksLikeCall(b.text)) : []) : this.fresh(e);
    this.prog = { writing, replySeen: byLayout.learned ? !!reply : blocks.length > 0, calls: blocks.length, how: byLayout.learned ? "learned" : "guessed" };
    for (const b of blocks) this.show(b, "waiting");
    // with the learned reply, its whole text tells whether it is still written
    // guessing, with nothing seen that shows the page writing: only the page as a whole standing still tells
    const blind = !byLayout.learned && !e.sawGenerating && !blocks.length;
    const sig = (reply ? `${squash(deepText(reply))}\u0001` : "") + blocks.map((b) => b.text).join("\u0000") + (blind ? `\u0002${pageText().length}` : "");
    if (sig !== this.latest.sig) {
      this.latest = { sig, since: now };
      return null;
    }
    // unchanged since the blocks last changed, and since the page stopped writing: a page may draw the code blocks
    // of a reply only as it finishes it
    const quiet = now - Math.max(this.latest.since, this.generatingAt);
    if (!blocks.length) {
      // an answer without a call: done once the page stopped writing (seen only when it shows that it writes); a
      // learned reply on a page without a learned indicator, once it stood still for a while
      // (a call that comes after a pause is still taken: see lookLate)
      const stillLong = (!!reply && !this.layout?.busy && quiet > NO_INDICATOR_STABLE_MS) || (blind && quiet > NO_INDICATOR_STABLE_MS);
      if ((e.sawGenerating && !writing && quiet > STABLE_MS && (!byLayout.learned || reply)) || stillLong) {
        dbg("answer without calls");
        this.after = { e, until: now + LATE_CALL_MS };
        this.expecting = null;
        this.prog = null;
        return { items: () => [], present: () => true, given: e.given };
      }
      if (!writing && now - e.at > EXPECT_MAX_MS) this.expecting = null;
      return null;
    }
    if (busy || writing) return null;
    const unreadable = blocks.some((b) => parseCalls([b.text]).problems.length);
    if (quiet < (unreadable ? UNREADABLE_STABLE_MS : STABLE_MS)) return null;
    this.expecting = null;
    this.prog = null;
    dbg("reply finished", blocks.length, byLayout.learned ? "learned" : "guessed");
    return {
      items: () => {
        const items: Item[] = [];
        for (const b of blocks) {
          const card = this.show(b, "live");
          const parsed = parseCalls([b.text]);
          if (parsed.calls.length || parsed.problems.length) items.push({ card, ...parsed });
        }
        return items;
      },
      present: () => true,
      given: e.given,
    };
  }

  /**
   * A page that draws its messages anew takes the cards away with the old blocks. While the calls run, their
   * cards (with Run, and the progress) go under the new block of the same text; afterwards they are let go.
   */
  private keepCards(busy: boolean): void {
    const lost = [...this.cards].filter(([el]) => !el.isConnected);
    if (!lost.length) return;
    if (!busy) {
      for (const [el, card] of lost) {
        card.drop();
        this.cards.delete(el);
      }
      return;
    }
    const live = lost.filter(([, card]) => card.mode === "live");
    if (!live.length) return;
    const all = this.layout?.code ? this.turns().flatMap((x) => (x.mine ? [] : this.blocksIn(x.el))) : codeBlocks();
    const free = (all.length ? all : codeBlocks()).filter((b) => !this.cards.has(b.el) && looksLikeCall(b.text));
    for (const [el, card] of live) {
      // the same calls: the page may draw the finished block otherwise (a heading, a Copy button), not word for word
      const calls = callsOf(card.text);
      let i = free.findIndex((b) => squash(b.text) === squash(card.text));
      if (i < 0) i = free.findIndex((b) => callsOf(b.text) === calls);
      // none like it: under the last call block, so that Run and Deny stay where they can be pressed
      if (i < 0) i = free.length - 1;
      if (i < 0) continue;
      const [b] = free.splice(i, 1);
      this.cards.delete(el);
      this.cards.set(b.el, card);
      b.el.after(card.host);
    }
  }

  /** The card under a block; a block still being written is parsed again when it grows. */
  private show(b: Block, mode: "waiting" | "live"): Card {
    let card = this.cards.get(b.el);
    if (!card) {
      card = new Card();
      this.cards.set(b.el, card);
    }
    if (card.host.previousElementSibling !== b.el) b.el.after(card.host);
    if (card.mode !== "live" && (card.mode !== mode || card.text !== b.text)) {
      const parsed = parseCalls([b.text]);
      card.setCalls(parsed.calls, parsed.problems, "waiting");
      card.mode = mode;
      card.text = b.text;
    }
    return card;
  }

  otherConversation(): void {
    this.after = null;
    // what went out before went to the other conversation; the last message may yet show up here
    this.tails = this.expecting ? [this.lastTail] : [];
    for (const c of this.cards.values()) c.drop();
    this.cards.clear();
    // another chat brings its own blocks along, and those are not the answer (it may yet come: the message may
    // not have been on the page yet); nothing counts until the message is seen there
    if (this.expecting) Object.assign(this.expecting, this.baseline(), { away: Date.now() });
  }

  stop(): void {
    this.gen++;
    this.expecting = null;
    this.after = null;
    this.prog = null;
    window.removeEventListener("focusin", this.onFocus, true);
    for (const c of this.cards.values()) c.drop();
    this.cards.clear();
  }
}
