// What the bridge needs of a chat page, whichever site it is: gemini.ts knows gemini.google.com element by
// element, generic.ts finds its way on any other chat page (Gemini Enterprise and the like).

import type { ParsedCall, ParseProblem } from "../shared/protocol.ts";
import type { Layout } from "./layout.ts";
import type { Card } from "./ui.ts";

/** The calls of one code block of a reply, with the card that shows them. */
export interface Item {
  card: Card;
  calls: ParsedCall[];
  problems: ParseProblem[];
}

/** A reply to a message the extension watched go out, finished. */
export interface Finished {
  /** Its calls, block by block, each card made live (no tick turns it into "earlier" again). */
  items(): Item[];
  /** False once the reply left the page (another conversation was opened): its results go nowhere. */
  present(): boolean;
  /** Hash of the instructions the message carried: they reached the conversation. */
  given?: string;
}

/** What the page shows of the answer to the message that went out, for the status line. */
export interface Progress {
  /** The page shows that it is writing. */
  writing: boolean;
  /** The answer is on the page (it may still grow). */
  replySeen: boolean;
  /** Call blocks in it so far. */
  calls: number;
  /** How the answer is found: the page is known (gemini.google.com), learned, or guessed. */
  how: "known" | "learned" | "guessed";
}

export interface Page {
  readonly kind: "gemini" | "generic";
  /**
   * The address does not always tell conversations apart (a new chat can open at the address of the last one):
   * the instructions remembered for an address count only when they are also on the page.
   */
  readonly addressShared: boolean;

  editorText(): string;
  insertAtStart(text: string): boolean;
  replaceText(text: string): boolean;
  /** Sends what is in the input box; true when it went (the box emptied or the page started writing). */
  submit(): Promise<boolean>;

  /** The user's Enter (trusted, without Shift) in the page's input box, with something in it to send. */
  isSendKey(e: KeyboardEvent): boolean;
  isSendClick(e: MouseEvent): boolean;
  isStopClick(e: MouseEvent): boolean;

  /** What tells one conversation from another in the address. */
  address(): string;
  /** The conversation of `address`, for the per-chat switch; "new" for a new chat that has no address yet. */
  chatKey(address?: string): string;
  /** The address changed from `from`, but the conversation is the same (a new chat got its address). */
  sameConversation(from: string): boolean;
  /** Under which the instructions given to this conversation are remembered; null while it has none. */
  givenKey(): string | null;
  /** The instructions are in one of the messages on the page. */
  instructionsOnPage(): boolean;

  /** A message is going out (`text` as sent): its answer is the next reply to handle. */
  expect(text: string, given?: string): void;
  unexpect(): void;
  /** Every tick: watches the replies and returns the awaited one once it is finished. Not while `busy`. */
  tick(active: boolean, busy: boolean): Finished | null;
  /** Another conversation was opened: nothing waited for in the last one counts here. */
  otherConversation(): void;
  /** The bridge was turned off in the tab: everything the page got from the extension goes. */
  stop(): void;
  /** While a message is awaited (as of the last tick): what the page shows of the answer. */
  progress(): Progress | null;
  /** What the extension learned about the site (pages it does not know). */
  useLayout?(layout: Layout | null): void;
  /** The input box and the send button: the extension's boxes are not to cover them. */
  inputArea(): Element[];
}

/** Where the page's input box and send button are, with what holds both (the box the user types in). */
export function inputAreaRects(els: Element[]): DOMRect[] {
  const out = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  const r = els[0] ? composerRect(els[0]) : null;
  if (r?.width && r.height) out.push(r);
  return out;
}

/** The box around the input box `ed` with its buttons: its largest ancestor not much taller than it, not page-wide. */
export function composerRect(ed: Element): DOMRect {
  let r = ed.getBoundingClientRect();
  for (let el = parentOf(ed), i = 0; el && i < 8; el = parentOf(el), i++) {
    const b = el.getBoundingClientRect();
    if (b.height > Math.max(r.height + 150, 220) || b.width > innerWidth * 0.95) break;
    r = b;
  }
  return r;
}

/** With localStorage["gmb-debug"] = "1" on the page, the steps go to the console. */
export function dbg(...args: unknown[]): void {
  try {
    if (localStorage.getItem("gmb-debug") === "1") console.debug("[gmb]", ...args);
  } catch {
    // storage blocked
  }
}

/** The extension's own elements (cards, the status button): never part of the page's content. */
export const isOurs = (el: Element) => el.localName.startsWith("gmb-");

/** The browser's elements a page may attach a shadow root to; the others keep the browser's own to themselves. */
const HOSTS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);
/** Elements of the browser's that hold no shadow root: a page attaches one right after making the element, if at all. */
const noShadow = new WeakSet<Element>();

/**
 * The shadow root of an element, also a closed one (an extension may look into those): of a custom element (with
 * a "-" in the name), or of one of the browser's elements a page may attach one to (a closed root on a <div>).
 */
export function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  if (!(el instanceof HTMLElement) || isOurs(el) || noShadow.has(el)) return null;
  const custom = el.localName.includes("-");
  if (!custom && !HOSTS.has(el.localName)) return null;
  try {
    const sr = chrome.dom?.openOrClosedShadowRoot(el) ?? null;
    // a custom element may get its root when it is defined, later
    if (!sr && !custom) noShadow.add(el);
    return sr;
  } catch {
    return null;
  }
}

const MONO = /mono|courier|consolas|menlo|monaco|code/i;

/** Drawn in a monospace font: code. */
export function isMonospace(el: Element): boolean {
  return MONO.test(getComputedStyle(el).fontFamily);
}

const SKIP_TEXT = new Set(["script", "style", "noscript", "template"]);
const BLOCK = new Set(["div", "p", "li", "tr", "pre", "section", "article", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** A line number drawn in a code block: digits only, and marked as not part of the code. */
function lineNumber(el: Element): boolean {
  const text = el.textContent ?? "";
  if (!/^\s*\d+\s*$/.test(text)) return false;
  if (el.hasAttribute("data-line-number") || /line-?num|lineno|gutter|(^|[-_\s])ln([-_\s]|$)/i.test(el.getAttribute("class") ?? "")) return true;
  return getComputedStyle(el).userSelect === "none";
}

/**
 * The text of a code block as copying it gives: without what is drawn in it but is not code (a Copy button,
 * line numbers, what is hidden from screen readers), shadow roots included, a line per row.
 */
export function codeText(el: Element): string {
  let out = "";
  const visit = (n: Node, top: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += (n as Text).data;
      return;
    }
    if (!(n instanceof Element)) return;
    if (isOurs(n) || SKIP_TEXT.has(n.localName)) return;
    if (!top && (isButtonish(n) || n.getAttribute("aria-hidden") === "true" || lineNumber(n))) return;
    if (n.localName === "br") {
      out += "\n";
      return;
    }
    if (!top && BLOCK.has(n.localName) && out && !out.endsWith("\n")) out += "\n";
    const sr = shadowOf(n);
    if (sr) for (const c of sr.childNodes) visit(c, false);
    for (const c of n.childNodes) visit(c, false);
  };
  visit(el, true);
  return out;
}

/**
 * Every element under `root`, in document order, shadow roots included (each right after its host), the
 * extension's own elements and the subtree of `skip` left out. Pages built of web components keep their
 * messages in shadow roots. `prune(el)`, asked once the caller had `el`: true when nothing under it is wanted
 * (its children and its shadow root are passed over).
 */
export function* deepElements(root: Element | ShadowRoot | Document, skip?: Element, prune?: (el: Element) => boolean): Generator<Element> {
  const own = root instanceof Element ? shadowOf(root) : null;
  if (own) yield* deepElements(own, skip, prune);
  // walked by hand: a filter callback for every element costs more than the walk itself
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n = w.firstChild() as Element | null;
  while (n) {
    let down = false;
    if (n !== skip && !isOurs(n)) {
      yield n;
      if (!prune?.(n)) {
        const sr = shadowOf(n);
        if (sr) yield* deepElements(sr, skip, prune);
        down = true;
      }
    }
    let next: Node | null = down ? w.firstChild() : null;
    while (!next && w.currentNode !== root) {
      next = w.nextSibling();
      if (!next && !w.parentNode()) break;
    }
    n = next as Element | null;
  }
}

/** `root` and every shadow root under it (each tree once): for reading all the text of a part of the page. */
export function* treesUnder(root: Element | ShadowRoot): Generator<Element | ShadowRoot> {
  yield root;
  const own = root instanceof Element && !isOurs(root) ? shadowOf(root) : null;
  if (own) yield* treesUnder(own);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode() as Element | null; n; n = w.nextNode() as Element | null) {
    if (isOurs(n)) continue;
    const sr = shadowOf(n);
    if (sr) yield* treesUnder(sr);
  }
}

/**
 * The element an event really started at. Events coming out of a closed shadow root name only its host; the
 * focus (for keys) or the point (for clicks) leads into it.
 */
export function deepTarget(e: Event): Element | null {
  const first = e.composedPath()[0];
  if (!(first instanceof Element)) return null;
  let el: Element = first;
  for (let i = 0; i < 20; i++) {
    const sr = el.shadowRoot ? null : shadowOf(el);
    if (!sr) break;
    let inner: Element | null = e instanceof MouseEvent ? sr.elementFromPoint(e.clientX, e.clientY) : sr.activeElement;
    if (e instanceof MouseEvent && (!inner || inner === el)) inner = elementAtByBox(sr, e.clientX, e.clientY);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/**
 * The innermost element of `root` whose box holds the point. Chrome's hit testing does not go into a closed shadow
 * root (elementFromPoint on it gives its host, even to an extension): the boxes tell instead.
 */
export function elementAtByBox(root: ShadowRoot, x: number, y: number): Element | null {
  let found: Element | null = null;
  for (const el of deepElements(root)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) found = el;
  }
  return found;
}

/** The node's parent element, through a shadow root to its host. */
export function parentOf(el: Node): Element | null {
  const p = el.parentNode;
  return p instanceof ShadowRoot ? p.host : p instanceof Element ? p : null;
}

/** The element one writes in that `el` is part of, or null. */
export function editableOf(el: EventTarget | null | undefined): HTMLElement | null {
  if (el instanceof HTMLTextAreaElement) return el.disabled || el.readOnly ? null : el;
  // a one-line field counts only when it is wide (a chat box, not a search filter)
  if (el instanceof HTMLInputElement) return /^(text|search|)$/.test(el.type) && !el.readOnly && el.getBoundingClientRect().width >= 240 ? el : null;
  if (el instanceof HTMLElement && el.isContentEditable) {
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }
  return null;
}

export function valueOf(ed: HTMLElement): string {
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) return ed.value.trim();
  return ed.innerText.replace(/\u00a0/g, " ").trim();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An element named for the status line and the logs, not too long. */
export const short = (el: Element | null) => (el ? describe(el).slice(0, 80) : "");

/** Selects all the text of the input box `ed`. */
export function selectAllIn(ed: HTMLElement): void {
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) ed.select();
  else select((r) => r.selectNodeContents(ed));
}

/** Puts the caret at the start of the input box `ed`. */
export function caretToStart(ed: HTMLElement): void {
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) ed.setSelectionRange(0, 0);
  else
    select((r) => {
      r.setStart(ed.firstChild ?? ed, 0);
      r.collapse(true);
    });
}

function select(set: (r: Range) => void): void {
  const range = document.createRange();
  set(range);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Writes `text` where the selection is in `ed`, the way typing does, so that the page's own editor follows. */
export function typeText(ed: HTMLElement, text: string): boolean {
  // an editor that keeps its own text takes typing through beforeinput: it cancels the event and writes the text
  // itself (execCommand fires no beforeinput). Where no one takes it, a script's event changes nothing.
  if (!(ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement)) {
    const before = new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true });
    if (!ed.dispatchEvent(before)) return true;
  }
  if (document.execCommand("insertText", false, text)) return true;
  // the editor turned the command down: hand it the text as a paste
  const data = new DataTransfer();
  data.setData("text/plain", text);
  return !ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
}

/** Names of send and stop buttons. */
export const SEND = /(^|[^a-z])(send|submit)([^a-z]|$)|보내기|전송|제출/i;
export const STOP = /(^|[^a-z])stop([^a-z]|$)|중지|정지|중단/i;

/** A button, or what a page uses as one. */
export const isButtonish = (el: Element) => el.localName === "button" || el.getAttribute("role") === "button" || /-button$/.test(el.localName);

/** What a button is called: its label, its tooltip, its test id, its icon's name; and those of a button around it. */
export function nameOf(el: Element): string {
  const parts: string[] = [];
  const add = (e: Element) => {
    for (const a of ["aria-label", "title", "data-test-id", "data-testid", "mattooltip", "icon"]) {
      const v = e.getAttribute(a);
      if (v) parts.push(v);
    }
    const text = (e.textContent ?? "").trim();
    if (text.length <= 40) parts.push(text);
  };
  add(el);
  const root = el.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : null;
  if (host && isButtonish(host)) add(host);
  return parts.join(" ");
}

/** The button the click went through, if any (it may land on an icon inside it). */
export function buttonOf(e: MouseEvent): Element | null {
  let el = deepTarget(e);
  for (let i = 0; el && i < 8; i++, el = parentOf(el)) if (isButtonish(el)) return el;
  return null;
}

/** Shown, and not disabled (nor its custom button element around it). */
export function usable(b: Element): boolean {
  if (b.getClientRects().length === 0) return false;
  if ((b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true") return false;
  const root = b.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : null;
  return !(host && (host.hasAttribute("disabled") || host.getAttribute("aria-disabled") === "true"));
}

// ---------------------------------------------------------------------------------------------------------
// The page's structure, for making the extension work on a page it does not know: tags, ids, classes and the
// attributes that name parts of a page, through shadow roots. No text of the page, only how long it is.

const SKIP = new Set(["script", "style", "link", "meta", "noscript", "template", "path", "defs", "g", "use", "symbol"]);
const NAMED = ["role", "data-test-id", "data-testid", "type", "name", "contenteditable", "aria-label", "placeholder", "title", "aria-live", "slot"];
const MAX_LINES = 8000;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line about an element: tag, id, classes, the naming attributes, how much text of its own. */
export function describe(el: Element): string {
  let s = el.localName;
  if (el.id) s += `#${cut(el.id, 40)}`;
  const classes = [...el.classList].slice(0, 6).map((c) => `.${cut(c, 32)}`);
  s += classes.join("");
  if (el.classList.length > 6) s += ".…";
  for (const a of NAMED) {
    const v = el.getAttribute(a);
    if (v !== null) s += ` [${a}${v ? `=${JSON.stringify(cut(v, a === "aria-label" || a === "title" || a === "placeholder" ? 40 : 60))}` : ""}]`;
  }
  if (el instanceof HTMLIFrameElement && el.src) {
    try {
      const u = new URL(el.src);
      s += ` [src=${u.origin}${u.pathname}]`;
    } catch {
      // not a URL
    }
  }
  let own = 0;
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) own += (n.textContent ?? "").trim().length;
  if (own) s += ` (text ${own})`;
  return s;
}

export function pageStructure(): string {
  const lines = [`${location.origin}${location.pathname}`, `${new Date().toISOString()} ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? ""}`, ""];
  const walk = (parent: Element | ShadowRoot, depth: number) => {
    const kids = [...parent.children].filter((k) => !SKIP.has(k.localName) && !isOurs(k));
    for (let i = 0; i < kids.length && lines.length < MAX_LINES; i++) {
      const el = kids[i];
      const sig = describe(el);
      // a long run of siblings that look the same (list items, lines of code): two of them, then the count
      let n = 1;
      while (i + n < kids.length && describe(kids[i + n]) === sig) n++;
      const pad = "  ".repeat(depth);
      lines.push(pad + sig);
      if (el.localName !== "svg") {
        const sr = shadowOf(el);
        if (sr) {
          lines.push(`${pad}  #shadow-root${sr.mode === "closed" ? " (closed)" : ""}`);
          walk(sr, depth + 2);
        }
        walk(el, depth + 1);
      }
      if (n > 3) {
        lines.push(`${pad}… ${n - 1} more ${el.localName} like this`);
        i += n - 1;
      }
    }
  };
  walk(document.documentElement, 0);
  if (lines.length >= MAX_LINES) lines.push("… (cut)");
  return lines.join("\n");
}
