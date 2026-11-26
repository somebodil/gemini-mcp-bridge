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
  // what 0.4.0 and before kept: a list per tool
  const old = (s: { policies: Settings["policies"]; autoSites?: unknown }) => normalizeSettings(s as unknown as Partial<Settings>);

  it("one list for every Auto tool, Gemini at first; an emptied list stays empty", () => {
    assert.deepEqual(settings({ policies: { a: "auto", b: "ask" } }).autoSites, [GEMINI_SITE]);
    assert.deepEqual(normalizeSettings(undefined).autoSites, [GEMINI_SITE]);
    assert.deepEqual(settings({ autoSites: [] }).autoSites, []);
    // the list stays when no tool is Auto
    assert.deepEqual(settings({ policies: { a: "ask" }, autoSites: ["https://chat\\.test"] }).autoSites, ["https://chat\\.test"]);
  });

  it("cleans up the list", () => {
    // @ts-expect-error: what a broken storage may hold
    assert.deepEqual(settings({ autoSites: [" x ", "x", "", 3, null, "y"] }).autoSites, ["x", "y"]);
    // @ts-expect-error: not a list
    assert.deepEqual(settings({ autoSites: "x" }).autoSites, [GEMINI_SITE]);
  });

  it("a list per tool, kept before, becomes one list of the sites of the Auto tools", () => {
    const s = old({ policies: { a: "auto", b: "auto", c: "ask", d: "auto" }, autoSites: { a: [GEMINI_SITE], b: [" https://chat\\.test", GEMINI_SITE, 3], c: ["https://ask\\.test"] } });
    // d had no list: it ran on Gemini; c is not Auto, so its sites never counted
    assert.deepEqual(s.autoSites, [GEMINI_SITE, "https://chat\\.test"]);
    assert.deepEqual(old({ policies: { a: "auto" }, autoSites: { a: [] } }).autoSites, [], "an emptied list stays empty");
    assert.deepEqual(old({ policies: { a: "ask" }, autoSites: {} }).autoSites, [GEMINI_SITE]);
    assert.deepEqual(old({ policies: JSON.parse('{"toString": "auto"}') as Settings["policies"], autoSites: {} }).autoSites, [GEMINI_SITE], "a name every object inherits");
  });

  it("the Auto tools are asked about on a site the patterns miss", () => {
    const s = settings({ policies: { a: "auto", b: "auto", c: "off", d: "ask" }, autoSites: [GEMINI_SITE, "https://chat\\.test"] });
    assert.deepEqual(policiesOn(s, GEMINI), { a: "auto", b: "auto", c: "off", d: "ask" });
    assert.deepEqual(policiesOn(s, "https://chat.test"), { a: "auto", b: "auto", c: "off", d: "ask" });
    assert.deepEqual(policiesOn(s, "https://evil.test"), { a: "ask", b: "ask", c: "off", d: "ask" });
    assert.deepEqual(policiesOn(s, ""), { a: "ask", b: "ask", c: "off", d: "ask" });
  });

  it("Always allow makes the tool Auto and adds the site to the list, once", () => {
    const s = settings({ policies: { a: "auto", b: "ask" } });
    allowSite(s, "b", "https://chat.test");
    assert.equal(s.policies.b, "auto");
    assert.deepEqual(s.autoSites, [GEMINI_SITE, "https://chat\\.test"]);
    allowSite(s, "a", "https://chat.test");
    allowSite(s, "new", GEMINI);
    assert.deepEqual(s.autoSites, [GEMINI_SITE, "https://chat\\.test"], "not twice");
    assert.equal(s.policies.new, "auto");
    // the defaults are not changed with it
    assert.deepEqual(DEFAULT_SETTINGS.autoSites, [GEMINI_SITE]);
  });

  it("Always allow keeps an Off tool off, and copes with names every object inherits", () => {
    const s = settings({ policies: { a: "off" } });
    allowSite(s, "a", "https://chat.test");
    assert.equal(s.policies.a, "off");
    assert.deepEqual(s.autoSites, [GEMINI_SITE]);
    for (const name of ["toString", "constructor", "hasOwnProperty"]) {
      allowSite(s, name, GEMINI);
      assert.equal(s.policies[name], "auto");
      assert.equal(policiesOn(normalizeSettings(s), GEMINI)[name], "auto");
    }
    allowSite(s, "__proto__", GEMINI);
    assert.equal(Object.getPrototypeOf(s.policies), Object.prototype);
  });
});
