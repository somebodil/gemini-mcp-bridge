import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiNamed } from "./layouts.ts";

describe("which AI answers", () => {
  it("is the AI the reply named, by its name or its maker, whatever the case", () => {
    for (const said of ["claude", "Claude", "Claude Opus", "Anthropic"]) assert.equal(aiNamed(said), "claude", said);
    for (const said of ["chatgpt", "ChatGPT", "GPT-5", "OpenAI", "codex"]) assert.equal(aiNamed(said), "chatgpt", said);
    for (const said of ["gemini", "Gemini 3", " GEMINI ", "Google"]) assert.equal(aiNamed(said), "gemini", said);
  });

  it("is another AI for any other name, and not known when the reply named none", () => {
    assert.equal(aiNamed("other"), "other");
    assert.equal(aiNamed("Llama"), "other");
    assert.equal(aiNamed(""), undefined);
    assert.equal(aiNamed("  "), undefined);
    assert.equal(aiNamed(undefined), undefined);
  });
});
