// Picking an element on the page by hand, as the element picker of the developer tools does: a clear layer over
// the whole page takes the clicks (the page does not react to them), the element under the pointer is outlined
// with its name, ↑ goes one layer out, ↓ one layer back in, ← and → to the element before and after it in the
// same layer, a click or Enter picks, Esc cancels. The wheel still scrolls what is under the pointer.

import { SHADOW_MODE } from "../shared/dom.ts";
import type { Role } from "./layout.ts";
import { ROLE_COLOR, roleName } from "./overlay.ts";
import { deepElements, elementAtByBox, isOurs, parentOf, shadowOf, short } from "./page.ts";
import { timed } from "./perf.ts";

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host { all: initial; position: fixed; inset: 0; z-index: 2147482998; cursor: crosshair; }
.box { position: fixed; box-sizing: border-box; border: 2px solid var(--c); background: color-mix(in srgb, var(--c) 12%, transparent);
  border-radius: 3px; pointer-events: none; }
.tag { position: absolute; left: -2px; top: -20px; padding: 1px 6px; border-radius: 4px 4px 4px 0; background: var(--c); color: #fff;
  font: 600 11px/16px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; white-space: nowrap; max-width: 60vw;
  overflow: hidden; text-overflow: ellipsis; }
.box.low .tag { top: auto; bottom: -20px; border-radius: 0 4px 4px 4px; }
`);

/** The innermost element of the page at a point, through shadow roots (closed ones by the boxes), the extension's own left out. */
export function deepElementAt(x: number, y: number): Element | null {
  let el: Element | null = document.elementsFromPoint(x, y).find((e) => !isOurs(e)) ?? null;
  for (let i = 0; el && i < 20; i++) {
    const sr = shadowOf(el);
    if (!sr) break;
    let inner: Element | null = sr.elementsFromPoint(x, y).find((e) => !isOurs(e) && e.getRootNode() === sr) ?? null;
    if (!inner) inner = elementAtByBox(sr, x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** The nearest element around `el` that scrolls. */
function scrollerOf(el: Element | null): Element | null {
  for (let cur = el; cur; cur = parentOf(cur)) {
    const style = getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight) return cur;
  }
  return document.scrollingElement;
}

/** The element before (-1) or after (1) `el` in its layer, of those that show (the extension's own left out). */
function siblingOf(el: Element, dir: 1 | -1): Element | null {
  const step = (e: Element) => (dir > 0 ? e.nextElementSibling : e.previousElementSibling);
  for (let s = step(el); s; s = step(s)) {
    if (isOurs(s)) continue;
    const r = s.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return s;
  }
  return null;
}

export class Picker {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly role: Role;
  /** The element under the pointer, and the one outlined (the arrow keys move from it). */
  private hovered: Element | null = null;
  private current: Element | null = null;
  /** The elements ↑ came from, for ↓. */
  private inner: Element[] = [];
  private readonly onChange: (el: Element | null) => void;
  private readonly onDone: (el: Element | null) => void;
  private done = false;
  private frame = 0;

  constructor(role: Role, onChange: (el: Element | null) => void, onDone: (el: Element | null) => void) {
    this.role = role;
    this.onChange = onChange;
    this.onDone = onDone;
    this.host = document.createElement("gmb-picker");
    this.root = this.host.attachShadow({ mode: SHADOW_MODE });
    this.root.adoptedStyleSheets = [SHEET];
    document.documentElement.append(this.host);
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "auxclick"]) {
      this.host.addEventListener(type, this.swallow, true);
    }
    this.host.addEventListener("pointermove", this.onMove);
    this.host.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("scroll", this.onScroll, true);
  }

  /** Nothing of a click reaches the page; the click itself picks. */
  private readonly swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "click" && e instanceof MouseEvent) this.onClick(e);
  };

  private readonly onMove = timed("picker.move", (e: PointerEvent) => {
    const el = deepElementAt(e.clientX, e.clientY);
    if (el === this.hovered) return;
    this.hovered = el;
    this.inner = [];
    this.select(el);
  });

  private onClick(e: MouseEvent): void {
    if (!e.isTrusted) return;
    // a click without a move before it (a touch screen): the element under it
    if (!this.current) this.select(deepElementAt(e.clientX, e.clientY));
    this.finish(this.current);
  }

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    scrollerOf(this.hovered)?.scrollBy({ top: e.deltaY, left: e.deltaX });
  };

  private readonly drawFrame = timed("picker.draw", () => this.draw());

  private readonly onScroll = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.drawFrame);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    const cur = this.current;
    if (e.key === "Escape") this.finish(null);
    else if (e.key === "Enter") this.finish(cur);
    else if (e.key === "ArrowUp" && cur) {
      const up = parentOf(cur);
      if (up && up !== document.documentElement) {
        this.inner.push(cur);
        this.select(up);
      }
    } else if (e.key === "ArrowDown" && cur) {
      const first = deepElements(cur).next();
      const down: Element | null = this.inner.pop() ?? (first.done ? null : first.value);
      if (down) this.select(down);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && cur) {
      const side = siblingOf(cur, e.key === "ArrowRight" ? 1 : -1);
      if (side) {
        // another branch: ↓ no longer goes back to where ↑ came from
        this.inner = [];
        const r = side.getBoundingClientRect();
        // out of sight (an earlier message): the page scrolls to it, and the outline follows the scroll
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) side.scrollIntoView({ block: "nearest", inline: "nearest" });
        this.select(side);
      }
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private select(el: Element | null): void {
    this.current = el;
    this.draw();
    this.onChange(el);
  }

  private draw(): void {
    const el = this.current;
    if (!el?.isConnected) {
      this.root.replaceChildren();
      return;
    }
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = r.top < 22 ? "box low" : "box";
    box.style.cssText = `--c:${ROLE_COLOR[this.role]};left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${roleName(this.role)} · ${short(el)}`;
    box.append(tag);
    this.root.replaceChildren(box);
  }

  private finish(el: Element | null): void {
    if (this.done) return;
    this.close();
    this.onDone(el);
  }

  /** Takes the layer away without picking. */
  close(): void {
    this.done = true;
    cancelAnimationFrame(this.frame);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("scroll", this.onScroll, true);
    this.host.remove();
  }
}
