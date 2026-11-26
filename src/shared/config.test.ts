import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, isLocalUrl, normalizeSettings } from "./config.ts";

describe("normalizeSettings", () => {
  it("fills in the defaults", () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  });

  it("keeps numbers within their bounds and rounds them", () => {
    const s = normalizeSettings({ maxResultChars: 10, callTimeoutSec: 99999.6 });
    assert.equal(s.maxResultChars, 1000);
    assert.equal(s.callTimeoutSec, 3600);
    assert.equal(normalizeSettings({ callTimeoutSec: Number.NaN }).callTimeoutSec, DEFAULT_SETTINGS.callTimeoutSec);
    assert.equal(normalizeSettings({ callTimeoutSec: 7.4 }).callTimeoutSec, 7);
    // a limit of rounds that older versions kept is dropped
    assert.equal("maxRounds" in normalizeSettings({ maxRounds: 2 } as Partial<typeof DEFAULT_SETTINGS>), false);
  });

  it("cleans up servers: trims, names, ids, drops entries without a URL", () => {
    const s = normalizeSettings({
      // @ts-expect-error: what an older or broken storage may hold
      servers: [{ url: " http://127.0.0.1:1/mcp ", token: " t ", name: "  " }, { name: "no url" }, null, { id: "x", name: "b", url: "http://localhost:2/mcp", enabled: false }],
    });
    assert.deepEqual(s.servers, [
      { id: "s0", name: "server1", url: "http://127.0.0.1:1/mcp", token: "t", enabled: true },
      { id: "x", name: "b", url: "http://localhost:2/mcp", token: "", enabled: false },
    ]);
  });

  it("keeps only known policies, and true unless false for switches", () => {
    // @ts-expect-error: a policy that does not exist
    const s = normalizeSettings({ policies: { a: "auto", b: "maybe", c: "off" }, enabled: undefined, autoSend: false });
    assert.deepEqual(s.policies, { a: "auto", c: "off" });
    assert.equal(s.enabled, true);
    assert.equal(s.autoSend, false);
  });
});

describe("isLocalUrl", () => {
  it("accepts 127.0.0.1 and localhost only", () => {
    assert.equal(isLocalUrl("http://127.0.0.1:7341/mcp"), true);
    assert.equal(isLocalUrl("https://localhost/mcp"), true);
    assert.equal(isLocalUrl("http://example.com/mcp"), false);
    assert.equal(isLocalUrl("http://127.0.0.1.example.com/mcp"), false);
    assert.equal(isLocalUrl("ftp://127.0.0.1/"), false);
    assert.equal(isLocalUrl("not a url"), false);
  });
});
