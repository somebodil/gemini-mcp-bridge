// What the extension learned about a chat page (learn.ts) and uses there (generic.ts): where the input box, the
// send button and the writing indicator are, and how messages, replies and code blocks look. One layout per site,
// kept in chrome.storage.local, shared by every tab of the site.
//
// One element (the input box, the send button) is kept as a Locator: from the document down through shadow roots,
// a CSS selector per tree. Elements of a kind (my messages, replies, code blocks) are kept as a Pattern: a selector
// each of them matches. Both are built of what stays the same when the page is loaded again: tags, stable ids and
// classes, test ids and roles; not names a framework makes up per load (ids with numbers, ng-tns-c12-3, css-1x2y)
// nor classes that tell a state (active, disabled, streaming), nor labels (a send button is labelled Stop while
// the page writes).

import { LAYOUTS_KEY, loadLayouts, storeLayout, type Layout, type Locator, type Pattern } from "../shared/layouts.ts";
import { deepElements, isOurs, nameOf, parentOf, shadowOf } from "./page.ts";

export { ROLES, type Layout, type Locator, type Pattern, type Role } from "../shared/layouts.ts";

// ---------------------------------------------------------------------------------------------------------
// What stays the same

const STATE_WORDS =
  /(^|[-_])(active|focus|focused|hover|hovered|disabled|enabled|selected|expanded|collapsed|open|opened|closed|visible|hidden|show|shown|loading|loaded|pending|ready|empty|filled|dirty|pristine|touched|untouched|valid|invalid|checked|animating|animated|streaming|generating|last|first|new|current|odd|even)($|[-_])/i;
const MADE_UP_PREFIX = /^(ng-|cdk-|css-|sc-|jsx-|svelte-|emotion-|_)/;

function fewDigits(s: string): boolean {
  return (s.match(/\d/g)?.length ?? 0) < 2;
}

/** A class a framework did not make up for this load, and that does not tell a state. */
export function stableClass(c: string): boolean {
  if (c.length > 40 || !/^[A-Za-z_-][\w-]*$/.test(c) || !fewDigits(c)) return false;
  if (MADE_UP_PREFIX.test(c) || STATE_WORDS.test(c)) return false;
  // a hash: upper and lower case letters and a digit, nothing between them
  return !/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9]+$/.test(c);
}

function stableValue(v: string): boolean {
  return v.length > 0 && v.length <= 60 && fewDigits(v) && !v.includes(":");
}

const ATTRS = ["data-testid", "data-test-id", "role", "name", "type", "contenteditable"];

/**
 * A data attribute that tells what an element is (data-message-author-role="user", data-kind="code"): some pages
 * tell my messages from replies by nothing else. Not one that tells its state, place or id (data-state="open",
 * data-index="3", data-streaming="true", data-message-id="…").
 */
function tellingData(name: string, v: string): boolean {
  if (!name.startsWith("data-") || ATTRS.includes(name)) return false;
  if (/(^|-)(id|ids|key|index|idx|state|status|time|date|count|length|pos|position|offset|start|end)$/.test(name)) return false;
  return /^[A-Za-z][A-Za-z_-]{0,29}$/.test(v) && !STATE_WORDS.test(v) && !/^(true|false|on|off|yes|no|none|null|undefined)$/i.test(v);
}

const quote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

/** The parts of a selector for `el` alone, from the least to the most specific. */
function variants(el: Element): string[] {
  const tag = CSS.escape(el.localName);
  const out = [tag];
  const id = el.id;
  if (id && /^[A-Za-z][\w-]*$/.test(id) && stableValue(id)) out.push(`${tag}#${CSS.escape(id)}`);
  let attrs = "";
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null && (a === "contenteditable" || stableValue(v))) attrs += `[${a}=${quote(v)}]`;
  }
  if (attrs) out.push(tag + attrs);
  for (const a of el.attributes) if (tellingData(a.name, a.value)) out.push(`${tag + attrs}[${CSS.escape(a.name)}=${quote(a.value)}]`);
  const classes = [...el.classList].filter(stableClass).map((c) => `.${CSS.escape(c)}`);
  for (const c of classes) out.push(tag + attrs + c);
  if (classes.length > 1) out.push(tag + attrs + classes.join(""));
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------------
// Locators

type Tree = Document | ShadowRoot;

function treeOf(el: Element): Tree {
  const r = el.getRootNode();
  return r instanceof ShadowRoot ? r : document;
}

function unique(tree: Tree, sel: string, el: Element): boolean {
  try {
    const all = tree.querySelectorAll(sel);
    return all.length === 1 && all[0] === el;
  } catch {
    return false;
  }
}

/**
 * The shortest selector that finds `el` and nothing else in its tree; a path from the tree's top otherwise. The
 * bare tag of `el` itself is not enough (but for a custom element): the only button now is one of many once a
 * reply with its copy buttons is there.
 */
function selectorIn(el: Element): string {
  const tree = treeOf(el);
  const tail: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const all = variants(cur);
    const vs = cur === el && all.length > 1 && !el.localName.includes("-") ? all.slice(1) : all;
    for (const v of vs) {
      const sel = [v, ...tail].join(" > ");
      if (unique(tree, sel, el)) return sel;
    }
    // none is enough at this level: the one that tells it from its siblings, else its place among them
    const parent: Element | null = cur.parentElement;
    const siblings = [...(parent ? parent.children : tree.children)].filter((s) => s !== cur);
    let part = vs.find((v) => !siblings.some((s) => s.matches(v)));
    if (!part) {
      const sameTag = [...(parent ? parent.children : tree.children)].filter((s) => s.localName === cur.localName);
      part = `${vs.at(-1)}:nth-of-type(${sameTag.indexOf(cur) + 1})`;
    }
    tail.unshift(part);
    const sel = tail.join(" > ");
    if (unique(tree, sel, el)) return sel;
  }
  return tail.join(" > ");
}

const located = new WeakMap<Element, Locator>();

/**
 * How to find `el` again after a reload: a selector per tree, from the document down. Kept per element; `fresh`
 * works it out again against the page as it is now (what is unique changes as the page fills).
 */
export function locatorOf(el: Element, fresh = false): Locator {
  const known = fresh ? undefined : located.get(el);
  if (known) return known;
  const out: string[] = [];
  for (let cur: Element | null = el; cur; ) {
    out.unshift(selectorIn(cur));
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  located.set(el, out);
  return out;
}

/** The element of a locator, or null when the page has none (yet). */
export function resolve(loc: Locator | undefined): Element | null {
  if (!loc?.length) return null;
  let tree: Tree = document;
  let el: Element | null = null;
  for (let i = 0; i < loc.length; i++) {
    try {
      el = tree.querySelector(loc[i]);
    } catch {
      return null;
    }
    if (!el) return null;
    if (i < loc.length - 1) {
      const sr = shadowOf(el);
      if (!sr) return null;
      tree = sr;
    }
  }
  return el;
}

export const sameLocator = (a: Locator | undefined, b: Locator | undefined) => !!a && !!b && a.join("\u0000") === b.join("\u0000");

// ---------------------------------------------------------------------------------------------------------
// Patterns

/** Tags that say what they are: a pattern may be the tag alone. */
const TELLING_TAGS = new Set(["pre", "code", "article", "li", "section"]);

/** `el` is of the kind (a broken selector matches nothing). */
export function matchesPattern(el: Element, sel: string): boolean {
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

/**
 * A selector that `example` matches and none of `avoid` does (the examples of the other kinds, and the elements
 * around the example, so that one message is not matched twice). The least specific that does: it matches the
 * other elements of the kind too.
 */
export function patternOf(example: Element, avoid: Element[]): Pattern | null {
  const own = variants(example);
  const parent = parentOf(example);
  const tree = example.getRootNode();
  // "parent > child" only within one tree: matches() does not see across a shadow root
  const withParent = parent && parent.getRootNode() === tree ? variants(parent).flatMap((p) => own.map((v) => `${p} > ${v}`)) : [];
  for (const sel of [...own, ...withParent]) {
    const bare = sel === CSS.escape(example.localName);
    if (bare && !example.localName.includes("-") && !TELLING_TAGS.has(example.localName)) continue;
    if (matchesPattern(example, sel) && !avoid.some((a) => matchesPattern(a, sel))) return sel;
  }
  return null;
}

/** The elements of a kind under `root` (shadow roots included), only the outermost of nested matches. */
export function findAll(pattern: Pattern | undefined, root: Element | Document, limit = 500): Element[] {
  if (!pattern) return [];
  const out: Element[] = [];
  let outer: Element | null = null;
  for (const el of deepElements(root)) {
    if (outer && contains(outer, el)) continue;
    if (matchesPattern(el, pattern)) {
      out.push(el);
      outer = el;
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** `a` holds `b`, also through shadow roots. */
export function contains(a: Element, b: Element): boolean {
  for (let el: Element | null = b; el; el = parentOf(el)) if (el === a) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Looks: what a button or an indicator shows, to tell the page writing from the page waiting

/** How an element looks for the purpose of telling states apart: its name, shown or not, disabled or not. */
export function lookOf(el: Element | null): string {
  if (!el?.isConnected) return "absent";
  if (el.getClientRects().length === 0) return "hidden";
  // a word once (a custom button and its inner button often carry the same name)
  const words = nameOf(el)
    .toLowerCase()
    .replace(/\d+/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const name = [...new Set(words)].join(" ").slice(0, 80);
  const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
  return disabled ? `${name} [disabled]` : name;
}

/** A look without whether it is disabled (a send button is disabled while the box is empty, writing or not). */
export const nameOnly = (look: string) => look.replace(/ \[disabled\]$/, "");

/** The page writes, by the learned or picked indicator; undefined when the indicator is not on the page. */
export function busyNow(busy: Layout["busy"]): boolean | undefined {
  if (!busy) return undefined;
  const el = resolve(busy.at);
  if (busy.look !== undefined) return el || busy.look === "absent" ? lookOf(el) === busy.look : undefined;
  if (!el || busy.idle === undefined) return undefined;
  const look = lookOf(el);
  return look !== "absent" && look !== "hidden" && nameOnly(look) !== busy.idle;
}

// ---------------------------------------------------------------------------------------------------------
// Text through shadow roots

const NO_TEXT = new Set(["script", "style", "noscript", "template"]);

/** The text of `el` as shown: shadow roots included, the extension's own elements left out. */
export function deepText(el: Element): string {
  const parts: string[] = [];
  const visit = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push((n as Text).data);
      return;
    }
    if (n instanceof Element) {
      if (isOurs(n) || NO_TEXT.has(n.localName)) return;
      const sr = shadowOf(n);
      if (sr) for (const c of sr.childNodes) visit(c);
    }
    for (const c of n.childNodes) visit(c);
  };
  visit(el);
  return parts.join("");
}

/** Letters and digits only: what is left of a text whatever the page does with spaces and marks. */
export const letters = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");

/** Text nodes under `root` (shadow roots included) whose text holds `needle`. */
export function textNodesWith(root: Element, needle: string): Text[] {
  const out: Text[] = [];
  const scan = (tree: Element | ShadowRoot) => {
    const walker = document.createTreeWalker(tree, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes(needle)) out.push(n as Text);
  };
  scan(root);
  for (const el of deepElements(root)) {
    const sr = shadowOf(el);
    if (sr) scan(sr);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Storage

export async function loadLayout(site = location.origin): Promise<Layout | null> {
  try {
    return (await loadLayouts())[site] ?? null;
  } catch {
    return null;
  }
}

export async function saveLayout(layout: Layout | null, site = location.origin): Promise<void> {
  await storeLayout(site, layout);
}

/** The layout of this site from a storage change, or undefined when the change does not touch it. */
export function layoutChange(changes: Record<string, chrome.storage.StorageChange>, site = location.origin): Layout | null | undefined {
  const c = changes[LAYOUTS_KEY];
  if (!c) return undefined;
  const l = (c.newValue as Record<string, Layout> | undefined)?.[site];
  return l && l.v === 1 ? l : null;
}
