// Learning a chat page the extension does not know. The user sends one test message while the extension only
// watches (no instructions go along, no call runs). The message asks for a code block holding a random word:
//  - the word in a text with the start of the message is the user's message as the page shows it,
//  - the word anywhere else is the reply's code block; going up from the two, the elements just below the
//    one that holds both are the message and the reply, and the scrolling element around them is the list,
//  - the buttons near the input box are looked at every few tenths of a second: the one that looked different
//    from just after the message went out until the reply was finished is the writing indicator (most often the
//    send button turned into a stop button), and the button the user clicked to send is the send button.
// The user stops the learning; what it found is kept for the site (layout.ts) and shown on the page.

import { t } from "../shared/i18n.ts";
import {
  contains,
  deepText,
  findAll,
  letters,
  locatorOf,
  lookOf,
  patternOf,
  resolve,
  ROLES,
  textNodesWith,
  type Layout,
  type Locator,
  type Role,
} from "./layout.ts";
import { buttonOf, deepElements, deepTarget, describe, editableOf, isButtonish, isOurs, parentOf, SEND, shadowOf, STOP, typeText, valueOf } from "./page.ts";

const TICK_MS = 300;
/** The reply's text unchanged this long, and the indicator back: the reply is finished. */
const QUIET_MS = 2000;
/** Without an indicator that changed back: the reply's text unchanged this long. */
const QUIET_NO_INDICATOR_MS = 4000;
/** The writing indicator changes within this time after the message went out. */
const BUSY_START_MS = 5000;
/** A click after which the input box still holds the test message this long did not send it. */
const SEND_CONFIRM_MS = 10_000;

export type Step = "input" | "send" | "busy" | "mine" | "reply" | "code" | "end";
export const STEPS: readonly Step[] = ["input", "send", "busy", "mine", "reply", "code", "end"];
export type Found = "ok" | "unsure" | "missing";

export interface RoleResult {
  role: Role;
  found: Found;
  el: Element | null;
  note?: string;
}

export interface LearnResult {
  /** Null when nothing worth keeping was found. */
  layout: Layout | null;
  roles: RoleResult[];
}

export interface LearnView {
  steps: { step: Step; state: "todo" | "now" | "done"; detail?: string }[];
  /** Everything was seen: the user can stop. */
  complete: boolean;
}

interface Sample {
  t: number;
  looks: Map<string, string>;
}

interface Sent {
  at: number;
  /** What the user clicked to send; null for Enter. */
  button: Element | null;
  /** The looks of the buttons near the input box at that moment. */
  before: Map<string, string>;
}

interface Parts {
  mine: Element;
  reply: Element;
  lca: Element;
  code: Element | null;
  /** The code block is a <pre>: sure. */
  codeSure: boolean;
  /** Found from the random word in both (not from the message's next sibling). */
  sure: boolean;
}

interface Busy {
  key: string;
  look: string;
  start: number;
  /** It looked different again later: the page stopped writing. */
  ended: boolean;
}

const short = (el: Element | null) => (el ? describe(el).slice(0, 80) : "");

/** Buttons near `from`: in its parent, its grandparent and so on, nearest first. */
function buttonsNear(from: Element, levels = 4, max = 60): Element[] {
  const out = new Set<Element>();
  let scope: Element | null = from;
  let inner: Element | undefined;
  for (let level = 0; scope && level < levels && out.size < max; level++, inner = scope, scope = parentOf(scope)) {
    for (const el of deepElements(scope, inner)) {
      if (isButtonish(el)) out.add(el);
      if (out.size >= max) break;
    }
  }
  return [...out];
}

/** What a click went to when it is not a button: the outermost element around it with a pointer cursor. */
function clickableOf(e: MouseEvent): Element | null {
  let found: Element | null = null;
  let el = deepTarget(e);
  for (let i = 0; el && i < 6; i++, el = parentOf(el)) {
    if (getComputedStyle(el).cursor === "pointer") found = el;
    else if (found) break;
  }
  return found;
}

/** A custom button element takes clicks on its inner <button>: that one is the one to press. */
function pressable(b: Element): Element {
  return shadowOf(b)?.querySelector("button") ?? b;
}

/** `el` and the elements around it, up to the document, through shadow roots. */
function chain(el: Element): Element[] {
  const out: Element[] = [];
  for (let cur: Element | null = el; cur; cur = parentOf(cur)) out.push(cur);
  return out;
}

function parentOfNode(n: Node): Element | null {
  const p = n.parentNode;
  return p instanceof ShadowRoot ? p.host : p instanceof Element ? p : null;
}

function selectAll(ed: HTMLElement): void {
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) ed.select();
  else {
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

export class Learner {
  readonly nonce: string;
  readonly message: string;
  /** The first letters of the message: the text that holds the word next to them is the user's message. */
  private readonly head: string;
  /** Letters of the JSON the reply should hold. */
  private readonly json: string;
  private input: HTMLElement | null = null;
  private inputLoc: Locator | null = null;
  private attempt: Sent | null = null;
  private sent: Sent | null = null;
  private samples: Sample[] = [];
  private readonly elements = new Map<string, Element>();
  private readonly locators = new Map<string, Locator>();
  private mineSeen = false;
  private parts: Parts | null = null;
  private replyText = "";
  private replyChangedAt = 0;
  private complete = false;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onChange: () => void;
  private lastView = "";

  constructor(onChange: () => void) {
    this.onChange = onChange;
    const rnd = crypto.getRandomValues(new Uint32Array(2));
    this.nonce = `q${rnd[0].toString(36)}${rnd[1].toString(36)}`.slice(0, 10);
    const json = `{"gmb_test": "${this.nonce}"}`;
    this.message = t("learnMessage", { json });
    this.head = letters(this.message).slice(0, 20);
    this.json = letters(json);
    window.addEventListener("focusin", this.onFocus, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("keydown", this.onKey, true);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  // -------------------------------------------------------------------------------------------------------
  // The user's steps

  private ours(e: Event): boolean {
    return e.composedPath().some((n) => n instanceof Element && isOurs(n));
  }

  private readonly onFocus = (e: FocusEvent) => {
    if (!e.isTrusted || this.sent || this.ours(e)) return;
    const ed = editableOf(deepTarget(e));
    if (ed) setTimeout(() => this.useInput(ed), 0);
  };

  /** The box the user clicked is the input box: the test message goes in, in place of what was there. */
  private useInput(ed: HTMLElement): void {
    if (this.stopped || this.sent) return;
    if (ed !== this.input || !valueOf(ed).includes(this.nonce)) {
      this.input = ed;
      this.inputLoc = locatorOf(ed);
      ed.focus();
      selectAll(ed);
      typeText(ed, this.message);
    }
    this.changed();
  }

  private inputNow(): HTMLElement | null {
    if (this.input?.isConnected) return this.input;
    const el = resolve(this.inputLoc ?? undefined);
    return el instanceof HTMLElement ? el : null;
  }

  private holdsMessage(): boolean {
    const box = this.inputNow();
    return !!box && valueOf(box).includes(this.nonce);
  }

  private readonly onClick = (e: MouseEvent) => {
    if (!e.isTrusted || this.sent || this.ours(e)) return;
    const ed = editableOf(deepTarget(e));
    if (ed) {
      if (!this.input) this.useInput(ed);
      return;
    }
    if (!this.holdsMessage()) return;
    const hit = buttonOf(e) ?? clickableOf(e);
    const b = hit && pressable(hit);
    // in the capture phase, before the page does anything: how the buttons look before the message goes
    if (b) this.attempt = { at: Date.now(), button: b, before: this.sample().looks };
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted || e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || this.sent) return;
    const ed = editableOf(deepTarget(e));
    if (!ed || ed !== this.inputNow() || !this.holdsMessage()) return;
    this.attempt = { at: Date.now(), button: null, before: this.sample().looks };
  };

  // -------------------------------------------------------------------------------------------------------
  // Watching

  private sample(): Sample {
    const looks = new Map<string, string>();
    const box = this.inputNow();
    if (box) {
      for (const b of buttonsNear(box)) {
        const loc = locatorOf(b);
        const key = loc.join(" | ");
        this.locators.set(key, loc);
        this.elements.set(key, b);
        looks.set(key, lookOf(b));
      }
    }
    return { t: Date.now(), looks };
  }

  private tick(): void {
    if (this.stopped || this.complete) return;
    const now = Date.now();
    if (this.attempt && !this.sent) {
      // it went when the box let go of the message, or the message is on the page
      if (!this.holdsMessage() || this.leaves().mine.length) {
        this.sent = this.attempt;
        this.attempt = null;
      } else if (now - this.attempt.at > SEND_CONFIRM_MS) this.attempt = null;
    }
    if (this.sent) {
      this.samples.push(this.sample());
      this.scan(now);
      if (this.finished(now)) this.complete = true;
    }
    this.changed();
  }

  /** Where the random word is on the page, outside the input box: in the user's message, and elsewhere. */
  private leaves(): { mine: Element[]; replies: Element[] } {
    const mine: Element[] = [];
    const replies: Element[] = [];
    const box = this.inputNow();
    for (const n of textNodesWith(document.body ?? document.documentElement, this.nonce)) {
      const p = parentOfNode(n);
      if (!p || (box && contains(box, p)) || p.getClientRects().length === 0) continue;
      const isMine = letters(n.data).includes(this.head) || letters(deepText(p)).includes(this.head);
      (isMine ? mine : replies).push(p);
    }
    return { mine, replies };
  }

  private scan(now: number): void {
    const { mine, replies } = this.leaves();
    if (mine.length) this.mineSeen = true;
    let parts: Parts | null = null;
    // the pair whose common element is the deepest: a copy of the message elsewhere (a title) is not the message
    let best = -1;
    for (const m of mine) {
      for (const r of this.ranked(replies)) {
        const p = this.partsOf(m, r);
        if (!p) continue;
        const depth = chain(p.lca).length;
        if (depth > best) {
          best = depth;
          parts = p;
        }
        break;
      }
    }
    if (!parts && mine.length && !replies.length) parts = this.nextSibling(mine.at(-1) as Element);
    if (!parts) return;
    this.parts = parts;
    const text = letters(deepText(parts.reply));
    if (text !== this.replyText) {
      this.replyText = text;
      this.replyChangedAt = now;
    }
  }

  /** The word in a code block first. */
  private ranked(replies: Element[]): Element[] {
    const inCode = (el: Element) => chain(el).slice(0, 5).some((a) => a.localName === "pre" || a.localName === "code");
    return [...replies.filter(inCode), ...replies.filter((r) => !inCode(r))];
  }

  private partsOf(mineLeaf: Element, replyLeaf: Element): Parts | null {
    const mineChain = chain(mineLeaf);
    const replyChain = chain(replyLeaf);
    const inMine = new Set(mineChain);
    const li = replyChain.findIndex((el) => inMine.has(el));
    if (li <= 0) return null;
    const lca = replyChain[li];
    const reply = replyChain[li - 1];
    const mine = mineChain[mineChain.indexOf(lca) - 1];
    if (!mine) return null;
    // the code block: a <pre> around the word, else the largest element around it that holds little more
    let pre: Element | null = null;
    let box: Element | null = null;
    const bound = this.json.length + 40;
    for (let i = 0; i < li - 1; i++) {
      const el = replyChain[i];
      if (letters(deepText(el)).length > bound) break;
      box = el;
      if (!pre && el.localName === "pre") pre = el;
    }
    return { mine, reply, lca, code: pre ?? box, codeSure: !!pre, sure: true };
  }

  /** The word is only in the user's message (the reply did not repeat it): the reply is what comes after it. */
  private nextSibling(mineLeaf: Element): Parts | null {
    let el: Element | null = mineLeaf;
    for (let i = 0; el && i < 8; i++, el = parentOf(el)) {
      let sib = el.nextElementSibling;
      while (sib && (isOurs(sib) || !letters(deepText(sib)))) sib = sib.nextElementSibling;
      const lca = parentOf(el);
      if (sib && lca) {
        const pre = [...deepElements(sib)].find((x) => x.localName === "pre") ?? null;
        return { mine: el, reply: sib, lca, code: pre, codeSure: false, sure: false };
      }
    }
    return null;
  }

  /** Elements near the input box that looked different from just after the message went out. */
  private busyCandidates(): Busy[] {
    const sent = this.sent;
    if (!sent || !this.samples.length) return [];
    const out: Busy[] = [];
    const keys = new Set<string>();
    for (const s of this.samples) for (const k of s.looks.keys()) keys.add(k);
    const last = this.samples.length - 1;
    for (const key of keys) {
      const el = this.elements.get(key);
      // a button in a message (copy, like) comes and stays: not the page's state
      if (el && this.parts && (contains(this.parts.reply, el) || contains(this.parts.mine, el))) continue;
      const looks = this.samples.map((s) => s.looks.get(key) ?? "absent");
      const look0 = sent.before.get(key) ?? "absent";
      for (let i = 0; i <= last; ) {
        let j = i;
        while (j < last && looks[j + 1] === looks[i]) j++;
        const start = this.samples[i].t;
        if (start - sent.at > BUSY_START_MS) break;
        if (looks[i] !== look0 && j > i) {
          out.push({ key, look: looks[i], start, ended: j < last });
          break;
        }
        i = j + 1;
      }
    }
    const rank = (b: Busy) => [
      b.ended ? 0 : 1,
      STOP.test(b.look) ? 0 : 1,
      b.look === "absent" || b.look === "hidden" ? 1 : 0,
      sent.button && this.elements.get(b.key) === sent.button ? 0 : 1,
      b.start,
    ];
    return out.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    });
  }

  private finished(now: number): boolean {
    if (!this.parts || now - this.replyChangedAt < QUIET_MS) return false;
    const busy = this.busyCandidates();
    if (busy.some((b) => b.ended)) return true;
    // a stop button still there: the page is still writing
    if (busy.some((b) => STOP.test(b.look))) return false;
    return now - this.replyChangedAt >= QUIET_NO_INDICATOR_MS;
  }

  // -------------------------------------------------------------------------------------------------------
  // What the user sees

  view(): LearnView {
    const busy = this.sent ? this.busyCandidates()[0] : undefined;
    const done: Record<Step, boolean> = {
      input: !!this.input,
      send: !!this.sent,
      busy: !!busy,
      mine: this.mineSeen,
      reply: !!this.parts,
      code: !!this.parts?.code,
      end: this.complete,
    };
    const detail: Partial<Record<Step, string>> = {
      input: short(this.input),
      send: this.sent ? (this.sent.button ? short(this.sent.button) : "Enter") : undefined,
      busy: busy?.look,
      mine: short(this.parts?.mine ?? null),
      reply: short(this.parts?.reply ?? null),
      code: short(this.parts?.code ?? null),
    };
    const firstOpen = STEPS.find((s) => !done[s]);
    return {
      steps: STEPS.map((step) => ({ step, state: done[step] ? "done" : step === firstOpen ? "now" : "todo", detail: done[step] ? detail[step] || undefined : undefined })),
      complete: this.complete,
    };
  }

  private changed(): void {
    const v = JSON.stringify(this.view());
    if (v === this.lastView) return;
    this.lastView = v;
    this.onChange();
  }

  private detach(): void {
    this.stopped = true;
    clearInterval(this.timer);
    window.removeEventListener("focusin", this.onFocus, true);
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("keydown", this.onKey, true);
  }

  cancel(): void {
    this.detach();
  }

  /** Ends the learning: what was found, as a layout for the site, and per role how sure. */
  stop(): LearnResult {
    const now = Date.now();
    // the page may have drawn its messages anew since: the elements as they are now
    if (this.sent) this.scan(now);
    const busy = this.busyCandidates()[0];
    this.detach();
    const layout: Layout = { v: 1, at: now };
    const roles: RoleResult[] = [];
    const add = (role: Role, found: Found, el: Element | null, note?: string) => roles.push({ role, found, el, note });

    const input = this.inputNow();
    if (input) {
      layout.input = locatorOf(input);
      add("input", resolve(layout.input) === input ? "ok" : "unsure", input);
    } else add("input", "missing", null, t("noteNotSeen"));

    if (this.sent?.button) {
      const b = this.sent.button.isConnected ? this.sent.button : null;
      layout.send = locatorOf(this.sent.button);
      add("send", b && resolve(layout.send) === b ? "ok" : "unsure", b ?? resolve(layout.send));
    } else if (this.sent) {
      // sent with Enter: a button by the box named like a send button
      const key = [...this.sent.before.entries()].find(([, look]) => SEND.test(look) && !STOP.test(look) && look !== "absent" && look !== "hidden")?.[0];
      const loc = key ? this.locators.get(key) : undefined;
      if (loc) {
        layout.send = loc;
        add("send", "unsure", resolve(loc) ?? this.elements.get(key as string) ?? null, t("noteEnter"));
      } else add("send", "missing", null, t("noteEnter"));
    } else add("send", "missing", null, t("noteNotSeen"));

    const busyLoc = busy ? this.locators.get(busy.key) : undefined;
    if (busy && busyLoc) {
      layout.busy = { at: busyLoc, look: busy.look };
      add("busy", busy.ended ? "ok" : "unsure", resolve(busyLoc) ?? this.elements.get(busy.key) ?? null, busy.ended ? undefined : t("noteNotBack"));
    } else add("busy", "missing", null, this.sent ? t("noteNoChange") : t("noteNotSeen"));

    const p = this.parts;
    if (p) {
      let list: Element | null = null;
      for (let el: Element | null = p.lca; el && el !== document.body && el !== document.documentElement; el = parentOf(el)) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) {
          list = el;
          break;
        }
      }
      layout.list = locatorOf(list ?? p.lca);
      add("list", list ? "ok" : "unsure", list ?? p.lca, list ? undefined : t("noteContainer"));

      const inside = (el: Element, limit = 3000) => [...deepElements(el)].slice(0, limit);
      const mineAvoid = [p.reply, ...inside(p.reply), ...chain(p.mine).slice(1)];
      const replyAvoid = [p.mine, ...inside(p.mine), ...chain(p.reply).slice(1)];
      const mineP = patternOf(p.mine, mineAvoid);
      const replyP = patternOf(p.reply, replyAvoid);
      if (mineP) layout.mine = mineP;
      if (replyP) layout.reply = replyP;
      const sure: Found = p.sure ? "ok" : "unsure";
      add("mine", mineP ? sure : "missing", p.mine, p.sure ? undefined : t("noteGuessed"));
      add("reply", replyP ? sure : "missing", p.reply, p.sure ? undefined : t("noteGuessed"));
      if (p.code) {
        const code = p.code;
        const around = chain(code).slice(1, chain(code).indexOf(p.reply) + 1);
        const others = inside(p.reply).filter((el) => !contains(code, el) && !around.includes(el));
        const codeP = patternOf(code, [...around, ...others]);
        if (codeP) layout.code = codeP;
        add("code", codeP ? (p.codeSure ? "ok" : "unsure") : "missing", code);
      } else add("code", "missing", null, t("noteNoCode"));
    } else {
      for (const role of ["list", "mine", "reply", "code"] as const) add(role, "missing", null, t("noteNotSeen"));
    }
    roles.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
    return { layout: layout.input || layout.reply ? layout : null, roles };
  }
}

/** A kept layout checked against the page as it is now: what is there, what is not. */
export function checkLayout(layout: Layout): RoleResult[] {
  const one = (role: Role, loc: Locator | undefined): RoleResult => {
    if (!loc) return { role, found: "missing", el: null, note: t("noteNotLearned") };
    const el = resolve(loc);
    return el ? { role, found: "ok", el } : { role, found: "missing", el: null, note: t("noteNotOnPage") };
  };
  const list = resolve(layout.list) ?? document.body;
  const kind = (role: Role, pattern: string | undefined): RoleResult => {
    if (!pattern) return { role, found: "missing", el: null, note: t("noteNotLearned") };
    const all = findAll(pattern, list);
    return all.length ? { role, found: "ok", el: all.at(-1) as Element, note: t("noteCount", { n: all.length }) } : { role, found: "missing", el: null, note: t("noteNotOnPage") };
  };
  const busy = one("busy", layout.busy?.at);
  if (busy.el && layout.busy) busy.note = lookOf(busy.el) === layout.busy.look ? t("noteBusyNow") : t("noteIdleNow");
  return [one("input", layout.input), one("send", layout.send), busy, one("list", layout.list), kind("mine", layout.mine), kind("reply", layout.reply), kind("code", layout.code)];
}

/** What to outline on the page for a layout: each role's element, and every element of each kind. */
export function outlineItems(layout: Layout): { role: Role; el: Element }[] {
  const out: { role: Role; el: Element }[] = [];
  for (const role of ["list", "input", "send"] as const) {
    const el = resolve(layout[role]);
    if (el) out.push({ role, el });
  }
  const busy = resolve(layout.busy?.at);
  if (busy && !out.some((o) => o.el === busy)) out.push({ role: "busy", el: busy });
  const list = resolve(layout.list) ?? document.body;
  for (const role of ["mine", "reply"] as const) for (const el of findAll(layout[role], list, 50)) out.push({ role, el });
  const replies = findAll(layout.reply, list, 50);
  for (const r of replies) for (const el of findAll(layout.code, r, 20)) out.push({ role: "code", el });
  return out;
}
