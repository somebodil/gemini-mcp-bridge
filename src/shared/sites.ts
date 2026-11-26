// Where the "Auto" tools run without asking: one list of site patterns for all of them. A pattern is a regular
// expression that has to match the whole address of the site (its origin: scheme, host and port), as
// https://gemini\.google\.com or https://(chat|www)\.example\.com. On every other site they are asked about.

import type { Policy, Settings } from "./config.ts";

/** Gemini's site: the list as it starts, and where every "Auto" stored before sites existed ran (the extension knew
 * no other page). */
export const GEMINI_SITE = "https://gemini\\.google\\.com";

/** The pattern of one site: its address, with the characters that mean something in a regular expression escaped. */
export function sitePattern(origin: string): string {
  return origin.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

const compiled = new Map<string, RegExp | null>();

/** The regular expression of a pattern, anchored at both ends; or why the pattern is not one. */
export function compileSite(pattern: string): { re: RegExp } | { error: string } {
  try {
    // alone first: "a)|(b" compiles only inside the group below, and would match far more than one site there
    new RegExp(pattern);
    return { re: new RegExp(`^(?:${pattern})$`, "i") };
  } catch (e) {
    // "Invalid regular expression: /(/: Unterminated group" → "Unterminated group"
    const text = e instanceof Error ? e.message : String(e);
    return { error: text.slice(text.lastIndexOf(": ") + 2) || text };
  }
}

function regex(pattern: string): RegExp | null {
  let re = compiled.get(pattern);
  if (re === undefined) {
    const got = compileSite(pattern);
    re = "re" in got ? got.re : null;
    if (compiled.size > 500) compiled.clear();
    compiled.set(pattern, re);
  }
  return re;
}

/** One of the patterns matches the whole address. A pattern that is not a regular expression matches nothing. */
export function allowedOn(patterns: readonly string[], origin: string): boolean {
  return !!origin && patterns.some((p) => regex(p)?.test(origin) === true);
}

/** A value the record holds itself: a tool may be named "toString" or "constructor", which every object inherits. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The policies as they apply on one site: where the patterns miss the site, the "Auto" tools are asked about. */
export function policiesOn(s: Pick<Settings, "policies" | "autoSites">, origin: string): Record<string, Policy> {
  const out = { ...s.policies };
  if (allowedOn(s.autoSites, origin)) return out;
  for (const [name, p] of Object.entries(out)) if (p === "auto") out[name] = "ask";
  return out;
}

/**
 * "Always allow" pressed on a site: the tool becomes "Auto", and the site joins the list, so that the other "Auto"
 * tools run there without asking too (the button's title says so). An "Off" tool stays off: it was turned off after
 * its card showed.
 */
export function allowSite(s: Settings, tool: string, origin: string): void {
  if (own(s.policies, tool) === "off" || tool === "__proto__") return;
  s.policies[tool] = "auto";
  if (!allowedOn(s.autoSites, origin)) s.autoSites = [...s.autoSites, sitePattern(origin)];
}

/**
 * A "." that stands for any character where the dot of an address was likely meant: not before *, +, ? or {, and
 * not in [...]. https://gemini.google.com matches https://gemini-google.com too, a site anyone can register.
 */
export function looseDot(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === ".") {
      const next = pattern[i + 1];
      if (next === undefined || !"*+?{".includes(next)) return true;
    }
  }
  return false;
}

/** What the box of sites on the options page holds, one line each (empty lines left out, numbered as typed). */
export interface SiteLine {
  /** 1 for the first line of the box. */
  line: number;
  pattern: string;
  /** Not a regular expression: why. */
  error?: string;
  /** Matches sites that have nothing to do with each other: likely every site (of a scheme). */
  anySite?: boolean;
  /** Has a "." that matches any character (looseDot). */
  looseDot?: boolean;
}

/** Two sites that have nothing to do with each other, per scheme. */
const UNRELATED = [
  ["https://a.invalid", "https://b.example"],
  ["http://a.invalid", "http://b.example:8080"],
];

export function readSites(text: string): SiteLine[] {
  const out: SiteLine[] = [];
  text.split("\n").forEach((raw, i) => {
    const pattern = raw.trim();
    if (!pattern) return;
    const got = compileSite(pattern);
    if ("error" in got) {
      out.push({ line: i + 1, pattern, error: got.error });
      return;
    }
    const anySite = UNRELATED.some((pair) => pair.every((o) => got.re.test(o)));
    out.push({ line: i + 1, pattern, ...(anySite ? { anySite } : {}), ...(!anySite && looseDot(pattern) ? { looseDot: true } : {}) });
  });
  return out;
}

/** The address of a site as the patterns see it, from what was typed (gemini.google.com, a whole URL); "" if none. */
export function originOf(typed: string): string {
  const s = typed.trim();
  if (!s) return "";
  for (const v of s.includes("://") ? [s] : [s, `https://${s}`]) {
    try {
      const u = new URL(v);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch {
      // not an address: try with https:// in front
    }
  }
  return "";
}
