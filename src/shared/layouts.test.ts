import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiNamed } from "./layouts.ts";

describe("which AI answers", () => {
  it("is one of the three names the test message allows, whatever the case; ChatGPT answers codex", () => {
    assert.equal(aiNamed("gemini"), "gemini");
    assert.equal(aiNamed(" Gemini "), "gemini");
    assert.equal(aiNamed("codex"), "chatgpt");
    assert.equal(aiNamed("CLAUDE"), "claude");
  });

  it("is another AI for null, and not known for anything the test message does not allow", () => {
    assert.equal(aiNamed("null"), "other");
    for (const said of ["", "  ", "chatgpt", "Gemini 3", "other", "constructor", undefined]) assert.equal(aiNamed(said), undefined, String(said));
  });
});
