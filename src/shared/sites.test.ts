import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./config.ts";
import { allowedOn, allowSite, compileSite, GEMINI_SITE, looseDot, originOf, policiesOn, readSites, sitePattern } from "./sites.ts";

const GEMINI = "https://gemini.google.com";

describe("site patterns", () => {
  it("match the whole address, and no more", () => {
    assert.equal(allowedOn([GEMINI_SITE], GEMINI), true);
    assert.equal(allowedOn([GEMINI_SITE], "https://gemini.google.com.evil.test"), false);
    assert.equal(allowedOn([GEMINI_SITE], "https://evil.test"), false);
    assert.equal(allowedOn([GEMINI_SITE], "http://gemini.google.com"), false, "another scheme");
    assert.equal(allowedOn(["gemini\\.google\\.com"], GEMINI), false, "without https:// it is not the whole address");
    assert.equal(allowedOn(["https://(chat|www)\\.example\\.com"], "https://www.example.com"), true);
    assert.equal(allowedOn(["https://(chat|www)\\.example\\.com"], "https://mail.example.com"), false);
    assert.equal(allowedOn(["https://.*\\.example\\.com"], "https://a.b.example.com"), true);
    assert.equal(allowedOn(["http://127\\.0\\.0\\.1:\\d+"], "http://127.0.0.1:5173"), true);
    assert.equal(allowedOn(["HTTPS://GEMINI\\.google\\.COM"], GEMINI), true, "case does not matter");
    assert.equal(allowedOn([], GEMINI), false);
    assert.equal(allowedOn([".*"], ""), false, "no site: nothing is allowed");
  });

  it("an alternation stays inside the anchors", () => {
    // ^(?:a|b)$, not ^a|b$ (which would allow any address that ends with b)
    assert.equal(allowedOn([`${GEMINI_SITE}|https://chat\\.test`], "https://evil.test/https://chat.test"), false);
    assert.equal(allowedOn([`${GEMINI_SITE}|https://chat\\.test`], "https://chat.test"), true);
  });

  it("a pattern that closes the group itself is not a regular expression, and matches nothing", () => {
    const sneaky = `${GEMINI_SITE})|(.*`;
    assert.ok("error" in compileSite(sneaky));
    assert.equal(allowedOn([sneaky], "https://evil.test"), false);
    assert.equal(allowedOn([sneaky, GEMINI_SITE], GEMINI), true, "the other lines still count");
  });

  it("tells why a pattern is not a regular expression", () => {
    assert.deepEqual(compileSite("https://(gemini"), { error: "Unterminated group" });
    assert.deepEqual(compileSite("https://[a-"), { error: "Unterminated character class" });
    assert.deepEqual(compileSite("*.example.com"), { error: "Nothing to repeat" });
    assert.deepEqual(compileSite("https://a: b)"), { error: "Unmatched ')'" });
    assert.deepEqual(compileSite("https://a\\"), { error: "\\ at end of pattern" });
    assert.deepEqual(compileSite("https://[z-a]"), { error: "Range out of order in character class" });
    assert.deepEqual(compileSite("https://(?x)"), { error: "Invalid group" });
    assert.deepEqual(compileSite("https://a{3,1}"), { error: "numbers out of order in {} quantifier" });
    assert.deepEqual(compileSite("https://(?<1>a)"), { error: "Invalid capture group name" });
  });

  it("the pattern of a site is that site alone", () => {
    for (const site of [GEMINI, "http://127.0.0.1:5173", "https://chat.example.test"]) {
      const p = sitePattern(site);
      assert.equal(allowedOn([p], site), true);
      assert.equal(allowedOn([p], site.replace(".", "x")), false, `${p}: a dot is a dot`);
    }
    assert.equal(sitePattern(GEMINI), GEMINI_SITE);
  });
});

describe("readSites", () => {
  it("numbers the lines as typed, leaves out empty ones, and finds the broken, the too wide and the loose", () => {
    assert.deepEqual(readSites(`  ${GEMINI_SITE}  \n\nhttps://(a\n.*\nhttps://.*\nhttps://[a-z.]+\nhttps://gemini.google.com\nhttps://.*\\.example\\.com`), [
      { line: 1, pattern: GEMINI_SITE },
      { line: 3, pattern: "https://(a", error: "Unterminated group" },
      { line: 4, pattern: ".*", anySite: true },
      { line: 5, pattern: "https://.*", anySite: true },
      { line: 6, pattern: "https://[a-z.]+", anySite: true },
      { line: 7, pattern: "https://gemini.google.com", looseDot: true },
      { line: 8, pattern: "https://.*\\.example\\.com" },
    ]);
    assert.deepEqual(readSites(" \n "), []);
  });

  it("a loose dot: one that is not escaped, not in [...], and not before a quantifier", () => {
    assert.equal(looseDot("https://gemini.google.com"), true);
    assert.equal(looseDot("https://gemini\\.google\\.com"), false);
    assert.equal(looseDot("https://.*\\.example\\.com"), false);
    assert.equal(looseDot("https://[a-z.]+\\.test"), false);
    assert.equal(looseDot("https://a\\\\.b"), true, "an escaped backslash, then a plain dot");
    assert.equal(looseDot("https://a."), true);
    assert.equal(looseDot("https://.{2,5}\\.test"), false);
  });

  it("reads an address to try from what was typed", () => {
    assert.equal(originOf("https://gemini.google.com/app/123?x=1"), GEMINI);
    assert.equal(originOf("gemini.google.com"), GEMINI);
    assert.equal(originOf("localhost:3000"), "https://localhost:3000");
    assert.equal(originOf("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
    assert.equal(originOf("  "), "");
    assert.equal(originOf("file:///tmp/x.html"), "");
  });
});

describe("Auto per site", () => {
  const settings = (s: Partial<Settings>) => normalizeSettings({ ...DEFAULT_SETTINGS, ...s });

  it("an Auto stored before sites, or just chosen, is Gemini's", () => {
    const s = settings({ policies: { a: "auto", b: "ask" } });
    assert.deepEqual(s.autoSites, { a: [GEMINI_SITE] });
    // an emptied list stays empty: the tool is asked about everywhere
    assert.deepEqual(settings({ policies: { a: "auto" }, autoSites: { a: [] } }).autoSites, { a: [] });
  });

  it("cleans up the lists, and keeps them only for Auto tools", () => {
    // @ts-expect-error: what a broken storage may hold
    const s = settings({ policies: { a: "auto", c: "ask" }, autoSites: { a: [" x ", "x", "", 3, null], b: ["y"], c: ["z"] } });
    assert.deepEqual(s.autoSites, { a: ["x"] });
    // @ts-expect-error: not a list
    assert.deepEqual(settings({ policies: { a: "auto" }, autoSites: { a: "x" } }).autoSites, { a: [GEMINI_SITE] });
  });

  it("an Auto tool is asked about on a site its patterns miss", () => {
    const s = settings({ policies: { a: "auto", b: "auto", c: "off", d: "ask" }, autoSites: { a: [GEMINI_SITE], b: ["https://chat\\.test"] } });
    assert.deepEqual(policiesOn(s, GEMINI), { a: "auto", b: "ask", c: "off", d: "ask" });
    assert.deepEqual(policiesOn(s, "https://chat.test"), { a: "ask", b: "auto", c: "off", d: "ask" });
    assert.deepEqual(policiesOn(s, ""), { a: "ask", b: "ask", c: "off", d: "ask" });
  });

  it("Always allow adds the site to an Auto tool, and starts a new list for any other", () => {
    const s = settings({ policies: { a: "auto", b: "ask" }, autoSites: { a: [GEMINI_SITE], b: [GEMINI_SITE] } });
    allowSite(s, "a", "https://chat.test");
    assert.deepEqual(s.autoSites.a, [GEMINI_SITE, "https://chat\\.test"]);
    allowSite(s, "a", "https://chat.test");
    assert.deepEqual(s.autoSites.a, [GEMINI_SITE, "https://chat\\.test"], "not twice");
    // b was set to Ask: Gemini, where it ran without asking before, stays off
    allowSite(s, "b", "http://127.0.0.1:5173");
    assert.equal(s.policies.b, "auto");
    assert.deepEqual(s.autoSites.b, ["http://127\\.0\\.0\\.1:5173"]);
    allowSite(s, "new", GEMINI);
    assert.deepEqual(normalizeSettings(s).autoSites.new, [GEMINI_SITE]);
  });

  it("Always allow keeps an Off tool off, and copes with names every object inherits", () => {
    const s = settings({ policies: { a: "off" } });
    allowSite(s, "a", GEMINI);
    assert.equal(s.policies.a, "off");
    assert.equal(s.autoSites.a, undefined);
    for (const name of ["toString", "constructor", "hasOwnProperty"]) {
      allowSite(s, name, GEMINI);
      assert.equal(s.policies[name], "auto");
      assert.deepEqual(s.autoSites[name], [GEMINI_SITE]);
      assert.equal(policiesOn(normalizeSettings(s), GEMINI)[name], "auto");
    }
    allowSite(s, "__proto__", GEMINI);
    assert.equal(Object.getPrototypeOf(s.autoSites), Object.prototype);
  });
});
