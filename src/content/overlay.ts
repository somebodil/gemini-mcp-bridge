// Outlines over the page: a coloured box and a name tag on each element the extension learned, so the user can
// see whether it learned the right ones. Clicks go through to the page; the boxes follow scrolling and redraws.

import { SHADOW_MODE } from "../shared/dom.ts";
import { t } from "../shared/i18n.ts";
import { problemOnce } from "../shared/report.ts";
import type { Role } from "./layout.ts";
import { timed } from "./perf.ts";

export const ROLE_COLOR: Record<Role, string> = {
  input: "#1a73e8",
  send: "#188038",
  busy: "#e37400",
  list: "#9334e6",
  mine: "#007b83",
  reply: "#d93025",
  code: "#b06000",
};

export function roleName(role: Role): string {
  return t(`role_${role}`);
}

const SHEET = new CSSStyleSheet();
SHEET.replaceSync(`
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147482999; }
.box { position: fixed; box-sizing: border-box; border: 2px solid var(--c); border-radius: 4px; }
.box.list { border-style: dashed; }
.tag { position: absolute; left: -2px; top: -20px; padding: 1px 6px; border-radius: 4px 4px 4px 0; background: var(--c); color: #fff;
  font: 600 11px/16px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif; white-space: nowrap; }
.box.low .tag { top: auto; bottom: -20px; border-radius: 0 4px 4px 4px; }
.box.inside .tag { top: auto; bottom: 0; left: 0; border-radius: 0 4px 0 0; }
`);

export interface Outline {
  role: Role;
  el: Element;
  /** Shown instead of the role's name. */
}

export class Overlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: (() => Outline[]) | null = null;
  private items: Outline[] = [];
  private frame = 0;

  /** Shows the outlines `source` gives, asking again now and then (the page may draw its elements anew). */
  show(source: () => Outline[]): void {
    this.source = source;
    if (!this.host) {
      this.host = document.createElement("gmb-overlay");
      this.root = this.host.attachShadow({ mode: SHADOW_MODE });
      this.root.adoptedStyleSheets = [SHEET];
    }
    if (!this.host.isConnected) document.documentElement.append(this.host);
    this.refresh();
    if (!this.timer) {
      this.timer = setInterval(timed("outline.refresh", () => this.refresh()), 1000);
      window.addEventListener("scroll", this.onMove, true);
      window.addEventListener("resize", this.onMove);
    }
  }


  hide(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.frame);
    window.removeEventListener("scroll", this.onMove, true);
    window.removeEventListener("resize", this.onMove);
    this.host?.remove();
    this.source = null;
    this.items = [];
  }

  private readonly drawFrame = timed("outline.draw", () => this.draw());

  private readonly onMove = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.drawFrame);
  };

  private refresh(): void {
    if (!this.source) return;
    try {
      this.items = this.source();
    } catch (e) {
      problemOnce("Could not find the parts to outline on the page.", e);
      this.items = [];
    }
    this.draw();
  }

  private draw(): void {
    const root = this.root;
    if (!root) return;
    const boxes: HTMLElement[] = [];
    for (const it of this.items) {
      if (!it.el.isConnected) continue;
      const r = it.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const box = document.createElement("div");
      box.className = `box ${it.role}`;
      // a box that fills the screen (the list) gets its tag inside at the bottom; one at the top edge, below it
      if (r.top < 22 && r.height > innerHeight * 0.6) box.classList.add("inside");
      else if (r.top < 22) box.classList.add("low");
      box.style.cssText = `--c:${ROLE_COLOR[it.role]};left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = roleName(it.role);
      box.append(tag);
      box.dataset.role = it.role;
      boxes.push(box);
    }
    root.replaceChildren(...boxes);
  }
}
