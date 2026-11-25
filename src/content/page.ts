// What the bridge needs of a chat page, whichever site it is: gemini.ts knows gemini.google.com element by
// element, generic.ts finds its way on any other chat page (Gemini Enterprise and the like).

import type { ParsedCall, ParseProblem } from "../shared/protocol.ts";
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

/**
 * The shadow root of a web component, also a closed one (an extension may look into those). Only custom elements
 * (with a "-" in the name): the browser's own elements keep theirs to themselves.
 */
export function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  if (!el.localName.includes("-") || !(el instanceof HTMLElement) || isOurs(el)) return null;
  try {
    return chrome.dom?.openOrClosedShadowRoot(el) ?? null;
  } catch {
    return null;
  }
}

/**
 * Every element under `root`, in document order, shadow roots included (each right after its host), the
 * extension's own elements and the subtree of `skip` left out. Pages built of web components keep their
 * messages in shadow roots.
 */
export function* deepElements(root: Element | ShadowRoot | Document, skip?: Element): Generator<Element> {
  const own = root instanceof Element ? shadowOf(root) : null;
  if (own) yield* deepElements(own, skip);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n === skip || isOurs(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element;
    yield el;
    const sr = shadowOf(el);
    if (sr) yield* deepElements(sr, skip);
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
    const inner: Element | null = e instanceof MouseEvent ? sr.elementFromPoint(e.clientX, e.clientY) : sr.activeElement;
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** The element's parent, through a shadow root to its host. */
export function parentOf(el: Element): Element | null {
  const p = el.parentNode;
  return p instanceof ShadowRoot ? p.host : p instanceof Element ? p : null;
}

// ---------------------------------------------------------------------------------------------------------
// The page's structure, for making the extension work on a page it does not know: tags, ids, classes and the
// attributes that name parts of a page, through shadow roots. No text of the page, only how long it is.

const SKIP = new Set(["script", "style", "link", "meta", "noscript", "template", "path", "defs", "g", "use", "symbol"]);
const NAMED = ["role", "data-test-id", "data-testid", "type", "name", "contenteditable", "aria-label", "placeholder", "title", "aria-live", "slot"];
const MAX_LINES = 8000;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describe(el: Element): string {
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
