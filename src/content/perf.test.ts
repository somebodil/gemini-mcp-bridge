import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { frameLine, groupInteractions, interactionLine, invokerText, overlapByName, shareText, shortUrl, type EventEntry, type FrameEntry } from "./perf.ts";

const event = (name: string, interactionId: number, startTime: number, duration: number, processingStart: number, processingEnd: number) =>
  ({ name, entryType: "event", interactionId, startTime, duration, processingStart, processingEnd, target: null, toJSON: () => ({}) }) as unknown as EventEntry;

describe("performance log", () => {
  it("counts the extension's time inside a slow moment, per function", () => {
    const spans = [
      { name: "tick", start: 0, end: 10 },
      { name: "click", start: 95, end: 105 },
      { name: "tick", start: 190, end: 230 },
      { name: "tick", start: 400, end: 410 },
    ];
    const share = overlapByName(spans, 100, 200);
    assert.deepEqual([...share], [
      ["click", 5],
      ["tick", 10],
    ]);
    assert.equal(shareText(share), "extension 15 ms (tick 10, click 5)");
    assert.equal(shareText(new Map()), "extension 0 ms");
    assert.equal(shareText(new Map([["tick", 0.2]])), "extension 0 ms");
  });

  it("makes one interaction of its events, as Chrome counts it", () => {
    const got = groupInteractions([
      event("pointerdown", 7, 1000, 120, 1010, 1020),
      event("click", 7, 1005, 392, 1020, 1350),
      event("keydown", 8, 3000, 104, 3002, 3090),
    ]);
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { kind: "click", start: 1000, duration: 392, wait: 10, handlers: 340, paint: 47, target: "?" });
    assert.equal(got[1].kind, "key");
    assert.match(interactionLine(got[0], new Map([["click", 3]])), /^\d\d:\d\d:\d\d slow click 392 ms \(wait 10, handlers 340, paint 47\) on \? · extension 3 ms \(click 3\)$/);
  });

  it("names scripts by where they came from, without their query", () => {
    assert.equal(shortUrl("https://www.gstatic.com/a/b/app.js?token=secret#x"), "www.gstatic.com/…/app.js");
    assert.equal(shortUrl("https://example.com/app.js"), "example.com/app.js");
    assert.equal(shortUrl("chrome-extension://abcdef/content.js"), "extension content.js");
    assert.equal(shortUrl(undefined), "inline");
    assert.equal(shortUrl("not a url"), "?");
    // an inline script's address is the page's: its path may name the conversation
    assert.equal(shortUrl("https://gemini.google.com/app/3f9c1a2b4d"), "gemini.google.com");
    assert.equal(shortUrl("https://chat.example/c/my-medical-question?x=1"), "chat.example");
    assert.equal(invokerText({ invokerType: "classic-script", invoker: "https://example.com/x/y.js?q=1" }), "classic-script example.com/…/y.js");
    assert.equal(invokerText({ invokerType: "event-listener", invoker: "BUTTON#send.onclick" }), "event-listener BUTTON#send.onclick");
    assert.equal(invokerText({}), "?");
  });

  it("writes a long frame with its slowest scripts and its layout", () => {
    const f = {
      name: "long-animation-frame",
      entryType: "long-animation-frame",
      startTime: 1000,
      duration: 520,
      blockingDuration: 470,
      renderStart: 1440,
      styleAndLayoutStart: 1460,
      scripts: [
        { invokerType: "user-callback", invoker: "Window.setInterval", sourceURL: "chrome-extension://abc/content.js", sourceFunctionName: "tick", duration: 30 },
        { invokerType: "event-listener", invoker: "BUTTON.onclick", sourceURL: "https://example.com/js/app.js?v=3", sourceFunctionName: "onClick", duration: 400, forcedStyleAndLayoutDuration: 25 },
      ],
      toJSON: () => ({}),
    } as unknown as FrameEntry;
    assert.match(
      frameLine(f, new Map([["tick", 30]])),
      /^\d\d:\d\d:\d\d long frame 520 ms \(blocking 470, style and layout 60\) · scripts: example\.com\/…\/app\.js onClick 400 ms \(event-listener BUTTON\.onclick, forced layout 25\); extension content\.js tick 30 ms \(user-callback Window\.setInterval\) · extension 30 ms \(tick 30\)$/,
    );
  });
});
