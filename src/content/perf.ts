// The performance log: an option, off unless the user turns it on to find out why a page is slow. It writes down
//  - how long the extension's own work on the page takes (its ticks, its handlers of clicks and keys), and
//  - the moments the page was slow for the user: a click or a key that took long to show its effect (what
//    Chrome's "Interaction to Next Paint" measures) and frames that took long, each with how much of that time
//    was the extension's own work.
// Lines of names and numbers, the site without its path, the tag and classes of the element clicked, the hosts
// and file names of the page's slow scripts: no text of the page. The service worker keeps the last lines for the options page and passes them to
// local-mcp-bridge-server, which appends them to its perf.log.
//
// Off, it costs nothing but a check of one variable per measured function.

import { TEST_BUILD } from "../shared/dom.ts";

/** Interactions that took at least this long to show are written down (Chrome counts 200 ms and more as poor). */
export const SLOW_INTERACTION_MS = 100;
/** Frames that took at least this long are written down (Chrome reports frames of 50 ms and more). */
export const LONG_FRAME_MS = 150;
const FLUSH_MS = TEST_BUILD ? 1000 : 10_000;
const SUMMARY_MS = TEST_BUILD ? 3000 : 60_000;
/** Chrome reports an interaction after its paint: the extension's work is kept this long to be matched to it. */
const KEEP_SPANS_MS = 30_000;
/** Interactions and frames written per flush; more are counted only. */
const MAX_ITEMS = 10;

export interface Span {
  name: string;
  start: number;
  end: number;
}

let monitor: PerfMonitor | null = null;

/** `fn`, measured under `name` while the performance log is on. */
export function timed<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args) => (monitor ? monitor.run(name, () => fn(...args)) : fn(...args));
}

/** Runs `fn` now, measured under `name` while the performance log is on. */
export function measure<R>(name: string, fn: () => R): R {
  return monitor ? monitor.run(name, fn) : fn();
}

/** Starts the performance log (when it is not running): lines go to `emit`. */
export function startPerf(emit: (lines: string[]) => void, about: string): void {
  if (!monitor) monitor = new PerfMonitor(emit, about);
}

/** Stops it, writing what is still pending. */
export function stopPerf(): void {
  const m = monitor;
  monitor = null;
  m?.stop();
}

export const perfRunning = () => monitor !== null;

// ---------------------------------------------------------------------------------------------------------
// What Chrome reports (not all of it is in TypeScript's lib yet)

export interface EventEntry extends PerformanceEntry {
  processingStart: number;
  processingEnd: number;
  interactionId?: number;
  target?: Node | null;
}

export interface ScriptEntry {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}

export interface FrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: ScriptEntry[];
}

export interface Interaction {
  kind: "click" | "key";
  start: number;
  /** The longest of its events: what Chrome counts for the interaction. */
  duration: number;
  wait: number;
  handlers: number;
  paint: number;
  target: string;
}

class PerfMonitor {
  private readonly emit: (lines: string[]) => void;
  private readonly stats = new Map<string, { n: number; total: number; max: number }>();
  private spans: Span[] = [];
  /** The extension's time since the last summary (outermost functions only). */
  private own = 0;
  private depth = 0;
  private events: EventEntry[] = [];
  private frames: FrameEntry[] = [];
  private readonly observers: PerformanceObserver[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private summaryAt = performance.now();
  private worst = { interactions: 0, interactionMax: 0, frames: 0, frameMax: 0 };

  constructor(emit: (lines: string[]) => void, about: string) {
    this.emit = emit;
    const types = PerformanceObserver.supportedEntryTypes;
    const watch = (type: string, opts: PerformanceObserverInit, take: (list: PerformanceObserverEntryList) => void) => {
      if (!types.includes(type)) return false;
      try {
        const o = new PerformanceObserver(take);
        o.observe(opts);
        this.observers.push(o);
        return true;
      } catch {
        return false;
      }
    };
    // every event of an interaction (16 ms is the least Chrome takes), so that a slow click is broken down with its
    // pointerdown and pointerup; the interactions that were not slow are dropped at the flush
    const events = watch("event", { type: "event", durationThreshold: 16 } as PerformanceObserverInit, (list) => {
      for (const e of list.getEntries() as EventEntry[]) if (e.interactionId) this.events.push(e);
    });
    const frames = watch("long-animation-frame", { type: "long-animation-frame" }, (list) => {
      for (const e of list.getEntries() as FrameEntry[]) if (e.duration >= LONG_FRAME_MS) this.frames.push(e);
    });
    const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "?";
    const missing = [events ? "" : "interactions", frames ? "" : "frames"].filter(Boolean);
    this.emit([
      `--- ${new Date().toLocaleString("sv")} ${location.origin} · ${about} · Chrome ${chrome} · writes down interactions of ${SLOW_INTERACTION_MS} ms and more, frames of ${LONG_FRAME_MS} ms and more${missing.length ? ` · this Chrome does not report ${missing.join(" or ")}` : ""}`,
    ]);
    this.timer = setInterval(() => this.flush(false), FLUSH_MS);
  }

  run<R>(name: string, fn: () => R): R {
    const start = performance.now();
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
      const end = performance.now();
      const s = this.stats.get(name);
      const d = end - start;
      if (s) {
        s.n++;
        s.total += d;
        if (d > s.max) s.max = d;
      } else this.stats.set(name, { n: 1, total: d, max: d });
      // only the outermost: an inner one is in it already
      if (this.depth === 0) {
        this.spans.push({ name, start, end });
        this.own += d;
      }
    }
  }

  stop(): void {
    clearInterval(this.timer);
    for (const o of this.observers) o.disconnect();
    this.flush(true);
  }

  private flush(all: boolean): void {
    const now = performance.now();
    const lines: string[] = [];
    // the events of an interaction may come in two lists: those of the last second wait for the next flush
    const ready: EventEntry[] = [];
    const later: EventEntry[] = [];
    for (const e of this.events) (all || e.startTime + e.duration < now - 1000 ? ready : later).push(e);
    this.events = later;
    const interactions = groupInteractions(ready).filter((it) => it.duration >= SLOW_INTERACTION_MS);
    for (const it of interactions.slice(0, MAX_ITEMS)) lines.push(interactionLine(it, overlapByName(this.spans, it.start, it.start + it.duration)));
    if (interactions.length > MAX_ITEMS) lines.push(`${clock()} and ${interactions.length - MAX_ITEMS} more slow interactions`);
    const frames = this.frames;
    this.frames = [];
    for (const f of frames.slice(0, MAX_ITEMS)) lines.push(frameLine(f, overlapByName(this.spans, f.startTime, f.startTime + f.duration)));
    if (frames.length > MAX_ITEMS) lines.push(`${clock()} and ${frames.length - MAX_ITEMS} more long frames`);
    this.worst.interactions += interactions.length;
    for (const it of interactions) this.worst.interactionMax = Math.max(this.worst.interactionMax, it.duration);
    this.worst.frames += frames.length;
    for (const f of frames) this.worst.frameMax = Math.max(this.worst.frameMax, f.duration);
    if (all || now - this.summaryAt >= SUMMARY_MS) {
      // a hidden tab is not slow for anyone: its minutes are not written, unless something happened in them
      if (!document.hidden || this.worst.interactions || this.worst.frames || all) lines.push(this.summary(now));
      this.stats.clear();
      this.own = 0;
      this.summaryAt = now;
      this.worst = { interactions: 0, interactionMax: 0, frames: 0, frameMax: 0 };
    }
    const keepFrom = now - KEEP_SPANS_MS;
    if (this.spans.length && this.spans[0].end < keepFrom) this.spans = this.spans.filter((s) => s.end >= keepFrom);
    if (lines.length) this.emit(lines);
  }

  private summary(now: number): string {
    const secs = Math.max(1, Math.round((now - this.summaryAt) / 1000));
    const own = this.own;
    const top = [...this.stats]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8)
      .map(([name, s]) => `${name} ×${s.n} ${ms(s.total)} ms${s.n > 1 && s.max >= 5 ? `, max ${ms(s.max)}` : ""}`);
    const w = this.worst;
    const page = [
      w.interactions ? `${w.interactions} slow interactions (worst ${ms(w.interactionMax)} ms)` : "no slow interaction",
      w.frames ? `${w.frames} long frames (worst ${ms(w.frameMax)} ms)` : "no long frame",
    ];
    return `${clock()} last ${secs} s: extension ${ms(own)} ms (${((own / (secs * 1000)) * 100).toFixed(1)} %)${top.length ? ` · ${top.join(" · ")}` : ""} | page: ${page.join(", ")}`;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The lines (pure, for the tests)

export const ms = (n: number) => String(Math.round(n));

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Per extension function, how much of [start, end] it took. */
export function overlapByName(spans: readonly Span[], start: number, end: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of spans) {
    const d = Math.min(end, s.end) - Math.max(start, s.start);
    if (d > 0) out.set(s.name, (out.get(s.name) ?? 0) + d);
  }
  return out;
}

/** "extension 4 ms (click 3, tick 1)", or "extension 0 ms". */
export function shareText(share: Map<string, number>): string {
  const total = [...share.values()].reduce((a, b) => a + b, 0);
  if (total < 0.5) return "extension 0 ms";
  const parts = [...share]
    .sort((a, b) => b[1] - a[1])
    .filter(([, d]) => d >= 0.5)
    .map(([n, d]) => `${n} ${ms(d)}`);
  return `extension ${ms(total)} ms (${parts.join(", ")})`;
}

/** The events of one interaction (pointerdown, pointerup, click; or keydown, keyup) as one. */
export function groupInteractions(entries: readonly EventEntry[]): Interaction[] {
  const by = new Map<number, EventEntry[]>();
  for (const e of entries) {
    const id = e.interactionId ?? 0;
    const list = by.get(id);
    if (list) list.push(e);
    else by.set(id, [e]);
  }
  const out: Interaction[] = [];
  for (const list of by.values()) {
    // as Chrome's own breakdown: from the input to the first handler, the handlers of all its events (a click's
    // runs after its pointerdown and pointerup), from the last handler to the paint
    let start = Infinity;
    let end = 0;
    let firstHandler = Infinity;
    let lastHandler = 0;
    let duration = 0;
    for (const e of list) {
      start = Math.min(start, e.startTime);
      end = Math.max(end, e.startTime + e.duration);
      firstHandler = Math.min(firstHandler, e.processingStart);
      lastHandler = Math.max(lastHandler, e.processingEnd);
      duration = Math.max(duration, e.duration);
    }
    out.push({
      kind: list.some((e) => e.name.startsWith("key")) ? "key" : "click",
      start,
      duration,
      wait: firstHandler - start,
      handlers: lastHandler - firstHandler,
      paint: Math.max(0, end - lastHandler),
      target: describe(list.find((e) => e.target)?.target ?? null),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** "button.send.primary": the tag and two classes; no text. */
export function describe(node: Node | null): string {
  if (!node || typeof Element === "undefined" || !(node instanceof Element)) return "?";
  const classes = [...node.classList]
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join("");
  return `${node.localName}${classes}`;
}

export function interactionLine(it: Interaction, share: Map<string, number>): string {
  return `${clock()} slow ${it.kind} ${ms(it.duration)} ms (wait ${ms(it.wait)}, handlers ${ms(it.handlers)}, paint ${ms(it.paint)}) on ${it.target} · ${shareText(share)}`;
}

/**
 * "www.gstatic.com/…/app.js": where a script came from. The name of a script file only, never the query (it may
 * carry anything) or another path: an inline script's address is the page's own, whose path may name the
 * conversation.
 */
export function shortUrl(url: string | undefined): string {
  if (!url) return "inline";
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const file = parts.pop() ?? "";
    if (u.protocol === "chrome-extension:") return `extension ${file}`;
    if (!/^[\w.-]+\.[cm]?js$/i.test(file)) return u.host;
    return `${u.host}${parts.length ? "/…" : ""}/${file}`;
  } catch {
    return "?";
  }
}

/** "event-listener BUTTON.onclick": what started a script. A script's own address is shortened like the others. */
export function invokerText(s: Pick<ScriptEntry, "invoker" | "invokerType">): string {
  const type = s.invokerType ?? "?";
  const inv = s.invoker ?? "";
  if (!inv) return type;
  return `${type} ${/^[a-z-]+:\/\//i.test(inv) ? shortUrl(inv) : inv.slice(0, 60)}`;
}

export function frameLine(f: FrameEntry, share: Map<string, number>): string {
  const end = f.startTime + f.duration;
  const parts = [`blocking ${ms(f.blockingDuration ?? 0)}`];
  if (f.styleAndLayoutStart) parts.push(`style and layout ${ms(end - f.styleAndLayoutStart)}`);
  const scripts = [...(f.scripts ?? [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((s) => {
      const where = shortUrl(s.sourceURL);
      const fn = s.sourceFunctionName ? ` ${s.sourceFunctionName}` : "";
      const forced = s.forcedStyleAndLayoutDuration && s.forcedStyleAndLayoutDuration >= 1 ? `, forced layout ${ms(s.forcedStyleAndLayoutDuration)}` : "";
      return `${where}${fn} ${ms(s.duration)} ms (${invokerText(s)}${forced})`;
    });
  return `${clock()} long frame ${ms(f.duration)} ms (${parts.join(", ")})${scripts.length ? ` · scripts: ${scripts.join("; ")}` : ""} · ${shareText(share)}`;
}
