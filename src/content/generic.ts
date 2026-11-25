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

import { looksLikeCall, MARK, parseCalls } from "../shared/protocol.ts";
import { buttonOf, SEND, STOP, dbg, deepElements, deepTarget, editableOf, isButtonish, nameOf, parentOf, shadowOf, typeText, usable, valueOf, type Finished, type Item, type Page } from "./page.ts";
import { Card } from "./ui.ts";

/** A reply's blocks unchanged this long (and the page not writing): the reply is finished. */
const STABLE_MS = 2000;
/** The same for a block that cannot be read yet: it may be cut off while the page still writes. */
const UNREADABLE_STABLE_MS = 6000;
/** Past this, a stop button that never goes away (a wrong guess) does not hold the reply back. */
const GENERATING_MAX_MS = 20_000;
const EXPECT_MAX_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const squash = (s: string) => s.replace(/\s+/g, "");
/** Letters and digits only: a message shown as markdown loses its marks, not those. */
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");
/** The text of the whole page, shadow roots included. */
function pageText(): string {
  const body = document.body ?? document.documentElement;
  const parts = [body.textContent ?? ""];
  for (const el of deepElements(body)) {
    const sr = shadowOf(el);
    if (sr) parts.push(sr.textContent ?? "");
  }
  return parts.join(" ");
}

/** A usable button named like `re` near `from`: in its parent, else its grandparent, and so on. */
function buttonNear(from: Element, re: RegExp, not?: RegExp): HTMLElement | null {
  let scope: Element | null = from;
  let inner: Element | undefined;
  for (let level = 0; scope && level < 10; level++, inner = scope, scope = parentOf(scope)) {
    // each step looks only at what the last one did not
    for (const el of deepElements(scope, inner)) {
      if (!(el instanceof HTMLElement) || !isButtonish(el)) continue;
      // a custom button element takes clicks on its inner <button>: the inner one is the one to press
      if (shadowOf(el)?.querySelector("button")) continue;
      const name = nameOf(el);
      if (re.test(name) && !(not && not.test(name)) && usable(el)) return el;
    }
  }
  return null;
}

function pressEnter(ed: HTMLElement): void {
  for (const type of ["keydown", "keypress", "keyup"]) {
    ed.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
  }
}

interface Block {
  el: HTMLElement;
  text: string;
}

/** Code blocks on the page in document order: <pre>, and <code> of more than one line outside one. */
function codeBlocks(): Block[] {
  const out: Block[] = [];
  for (const el of deepElements(document.body ?? document.documentElement)) {
    if (el.localName !== "pre" && el.localName !== "code") continue;
    if (el.localName === "code" && el.closest("pre")) continue;
    const text = el.textContent ?? "";
    if (el.localName === "code" && !text.includes("\n")) continue;
    out.push({ el: el as HTMLElement, text });
  }
  return out;
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
}

export class GenericPage implements Page {
  readonly kind = "generic";
  readonly addressShared = true;
  private ed: HTMLElement | null = null;
  private expecting: Expect | null = null;
  /** The end of the last message that went out, letters and digits only: while the page shows it, the conversation is the same. */
  private lastTail = "";
  private latest = { sig: "", since: 0 };
  /** When the page began to show its stop button, and when it was last seen: 0 while it is not shown. */
  private generatingSince = 0;
  private generatingAt = 0;
  private readonly cards = new Map<Element, Card>();

  constructor() {
    window.addEventListener("focusin", this.onFocus, true);
  }

  private readonly onFocus = (e: FocusEvent) => {
    const ed = editableOf(deepTarget(e));
    if (ed) this.ed = ed;
  };

  /** The input box: the one the user wrote in last, else the last one on the page that one can write in. */
  private editor(): HTMLElement | null {
    if (this.ed?.isConnected) return this.ed;
    let found: HTMLElement | null = null;
    for (const el of deepElements(document.body ?? document.documentElement)) {
      const box = el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable && !el.parentElement?.isContentEditable);
      const ed = box ? editableOf(el) : null;
      if (ed && ed.getClientRects().length) found = ed;
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
    if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) ed.setSelectionRange(0, 0);
    else {
      const range = document.createRange();
      range.setStart(ed.firstChild ?? ed, 0);
      range.collapse(true);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return typeText(ed, text);
  }

  replaceText(text: string): boolean {
    const ed = this.editor();
    if (!ed) return false;
    ed.focus();
    if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) ed.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(ed);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return typeText(ed, text);
  }

  /** Presses the send button next to the input box; without one, or when it did nothing, Enter in the box. */
  async submit(timeoutMs = 8000): Promise<boolean> {
    // the page's editor may take the new text into its own state a moment later
    await sleep(300);
    const ed = this.editor();
    if (!ed) return false;
    const start = Date.now();
    let clickedAt = 0;
    let entered = false;
    const went = () => valueOf(ed) === "" || this.isGenerating();
    while (Date.now() - start < timeoutMs) {
      if ((clickedAt || entered) && went()) return true;
      if (!clickedAt) {
        const b = buttonNear(ed, SEND, STOP);
        if (b) {
          b.click();
          clickedAt = Date.now();
        }
      }
      // Enter when there is no send button, or when the click did nothing (the button is still there, ready):
      // never after a click the page took (it may clear the box only once its server answered)
      const pressNow = clickedAt ? Date.now() - clickedAt > 1500 && buttonNear(ed, SEND, STOP) !== null : Date.now() - start > 1000;
      if (!entered && pressNow) {
        ed.focus();
        pressEnter(ed);
        entered = true;
      }
      await sleep(100);
    }
    return went();
  }

  isSendKey(e: KeyboardEvent): boolean {
    const ed = editableOf(deepTarget(e));
    if (!ed) return false;
    this.ed = ed;
    return valueOf(ed) !== "";
  }

  isSendClick(e: MouseEvent): boolean {
    const b = buttonOf(e);
    if (!b) return false;
    const name = nameOf(b);
    return SEND.test(name) && !STOP.test(name) && this.editorText() !== "";
  }

  isStopClick(e: MouseEvent): boolean {
    const b = buttonOf(e);
    return !!b && STOP.test(nameOf(b));
  }

  /** A stop button near the input box: the page is writing a reply. */
  private isGenerating(): boolean {
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
    return this.lastTail.length >= 8 && letters(pageText()).includes(this.lastTail);
  }

  givenKey(): string | null {
    return location.host + this.address();
  }

  instructionsOnPage(): boolean {
    const body = document.body;
    if (body?.textContent?.includes(MARK.instructions)) return true;
    for (const el of deepElements(body ?? document.documentElement)) if (shadowOf(el)?.textContent?.includes(MARK.instructions)) return true;
    return false;
  }

  expect(text: string, given?: string): void {
    this.expecting = { ...this.baseline(), sent: squash(text), at: Date.now(), sawGenerating: false, given };
    this.lastTail = letters(text).slice(-60);
    this.latest = { sig: "", since: Date.now() };
    dbg("expecting", this.expecting.before.size, this.expecting.last?.localName);
  }

  unexpect(): void {
    this.expecting = null;
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
    for (const b of codeBlocks()) {
      if (b.el === e.last) {
        after = true;
        continue;
      }
      if (!looksLikeCall(b.text)) continue;
      const key = squash(b.text);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (after && n > (e.before.get(key) ?? 0) && !e.sent.includes(key)) out.push(b);
    }
    return out;
  }

  tick(active: boolean, busy: boolean): Finished | null {
    if (this.cards.size) this.keepCards(busy);
    const e = this.expecting;
    if (!e || !active) return null;
    const now = Date.now();
    const generating = this.isGenerating();
    if (generating) {
      e.sawGenerating = true;
      this.generatingSince ||= now;
      this.generatingAt = now;
    } else this.generatingSince = 0;
    const blocks = this.fresh(e);
    for (const b of blocks) this.show(b, "waiting");
    const sig = blocks.map((b) => b.text).join("\u0000");
    if (sig !== this.latest.sig) {
      this.latest = { sig, since: now };
      return null;
    }
    // unchanged since the blocks last changed, and since the page stopped writing: a page may draw the code blocks
    // of a reply only as it finishes it
    const quiet = now - Math.max(this.latest.since, this.generatingAt);
    if (!blocks.length) {
      // an answer without a call: done once the page stopped writing (seen only when it shows a stop button)
      if (e.sawGenerating && !generating && quiet > STABLE_MS) {
        dbg("answer without calls");
        this.expecting = null;
        return { items: () => [], present: () => true, given: e.given };
      }
      if (!generating && now - e.at > EXPECT_MAX_MS) this.expecting = null;
      return null;
    }
    if (busy || (generating && now - this.generatingSince < GENERATING_MAX_MS)) return null;
    const unreadable = blocks.some((b) => parseCalls([b.text]).problems.length);
    if (quiet < (unreadable ? UNREADABLE_STABLE_MS : STABLE_MS)) return null;
    this.expecting = null;
    dbg("reply finished", blocks.length);
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
    const free = codeBlocks().filter((b) => !this.cards.has(b.el));
    for (const [el, card] of live) {
      const i = free.findIndex((b) => squash(b.text) === squash(card.text));
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
    for (const c of this.cards.values()) c.drop();
    this.cards.clear();
    // another chat brings its own blocks along, and those are not the answer (it may yet come: the message may
    // not have been on the page yet)
    if (this.expecting) Object.assign(this.expecting, this.baseline());
  }

  stop(): void {
    this.expecting = null;
    window.removeEventListener("focusin", this.onFocus, true);
    for (const c of this.cards.values()) c.drop();
    this.cards.clear();
  }
}
