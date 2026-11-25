import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInstructions,
  buildToolsUpdate,
  describeTool,
  extractObjects,
  formatResults,
  MARK,
  parseCalls,
  summarizeResults,
  toolsHash,
  truncate,
} from "./protocol.ts";

const readFile = {
  name: "read_file",
  description: "Read a text file.\n  Lines are numbered.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path" },
      limit: { type: "integer" },
      mode: { enum: ["text", "base64"] },
      opts: { type: "object", properties: { follow: { type: "boolean" } }, required: ["follow"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["path"],
  },
};

describe("instructions", () => {
  it("opens and closes with the markers and lists every tool", () => {
    const s = buildInstructions([readFile, { name: "ping" }], ["OS: macOS"]);
    assert.ok(s.startsWith(MARK.instructions));
    assert.ok(s.endsWith(MARK.instructionsEnd));
    assert.match(s, /- read_file: Read a text file\. Lines are numbered\./);
    assert.match(s, /- ping: \(no description\)\n {2}arguments: \{\}/);
    assert.match(s, /About my computer and the tools:\n {2}OS: macOS/);
    // asks for requests to the user's helper, and shows one exchange with a tool that exists
    assert.match(s, /You cannot access my computer, but I can/);
    assert.match(s, /- You: `\{"mcp_call": \{"tool": "read_file", "arguments": \{"path":"~\/Documents"\}\}\}`/);
  });

  it("shows no example when no tool fits one", () => {
    assert.doesNotMatch(buildInstructions([{ name: "ping" }]), /An example/);
  });

  it("says so when there is no tool", () => {
    assert.match(buildToolsUpdate([]), /Tools you can request: none right now\./);
  });

  it("writes a compact signature with optional marks and parameter descriptions", () => {
    const lines = describeTool(readFile);
    assert.equal(
      lines[1],
      '  arguments: {"path": string, "limit"?: integer, "mode"?: "text" | "base64", "opts"?: {"follow": boolean}, "tags"?: string[]}',
    );
    assert.equal(lines[2], "    path: Absolute path");
  });

  it("hashes the tool list stably", () => {
    assert.equal(toolsHash([readFile]), toolsHash([readFile]));
    assert.notEqual(toolsHash([readFile]), toolsHash([readFile], ["note"]));
  });
});

describe("parseCalls", () => {
  it("reads the documented shape", () => {
    const r = parseCalls(['{"mcp_call": {"tool": "read_file", "arguments": {"path": "/a"}}}\n']);
    assert.deepEqual(r, { calls: [{ tool: "read_file", arguments: { path: "/a" } }], problems: [] });
  });

  it("ignores code blocks without the key, and blocks that only mention it", () => {
    assert.deepEqual(parseCalls(['{"tool": "x"}', "print('hi')", "the mcp_call blocks", "mcp_call"]), { calls: [], problems: [] });
  });

  it("accepts the near misses", () => {
    const r = parseCalls([
      '{"mcp_call": {"name": "a", "args": {"x": 1}}}',
      '{"mcp_call": {"tool": "b", "arguments": "{\\"y\\": 2}"}}',
      '{"mcp_call": {"tool": "c",}}',
      "{“mcp_call”: {“tool”: “d”}}",
    ]);
    assert.deepEqual(r.calls, [
      { tool: "a", arguments: { x: 1 } },
      { tool: "b", arguments: { y: 2 } },
      { tool: "c", arguments: {} },
      { tool: "d", arguments: {} },
    ]);
  });

  it("reports blocks it cannot read so that Gemini can retry", () => {
    const r = parseCalls(['{"mcp_call": {"tool": "a", "arguments": {"x": }}}', '{"mcp_call": {"arguments": {}}}', '{"mcp_call": []}']);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(
      r.problems.map((p) => p.error),
      ["The block is not valid JSON.", '"mcp_call" has no "tool" name.', '"mcp_call" must be an object with "tool" and "arguments".'],
    );
  });

  it("finds several calls in order, also in one block", () => {
    const r = parseCalls(['{"mcp_call": {"tool": "a"}}\n{"mcp_call": {"tool": "b"}}', '{"mcp_call": {"tool": "c"}}']);
    assert.deepEqual(
      r.calls.map((c) => c.tool),
      ["a", "b", "c"],
    );
  });

  it("falls back to the plain text only when no block holds a call", () => {
    const text = 'Sure.\n{"mcp_call": {"tool": "a", "arguments": {"s": "a } b"}}}\nDone';
    assert.deepEqual(parseCalls([], text).calls, [{ tool: "a", arguments: { s: "a } b" } }]);
    assert.deepEqual(
      parseCalls(['{"mcp_call": {"tool": "b"}}'], text).calls.map((c) => c.tool),
      ["b"],
    );
  });

  it("keeps braces inside strings", () => {
    assert.deepEqual(extractObjects('x {"a": "{"} y {"b": 1}').map((o) => o.value), [{ a: "{" }, { b: 1 }]);
  });
});

describe("results", () => {
  it("formats each outcome with a fence longer than any backtick run in it", () => {
    const s = formatResults(
      [
        { tool: "a", ok: true, text: "one" },
        { tool: "b", ok: false, text: "has ```` four" },
      ],
      10000,
    );
    assert.equal(s, [MARK.results, "#1 a → ok", "```text", "one", "```", "#2 b → error", "`````text", "has ```` four", "`````"].join("\n"));
    assert.equal(summarizeResults(s), "a ✓ · b ✗");
  });

  it("splits the budget among the outcomes", () => {
    const s = formatResults(
      [
        { tool: "a", ok: true, text: "x".repeat(5000) },
        { tool: "b", ok: true, text: "" },
      ],
      4000,
    );
    assert.match(s, /\.\.\.\[truncated 3000 characters\]/);
    assert.match(s, /\(no output\)/);
  });

  it("truncates only when needed", () => {
    assert.equal(truncate("abc", 3), "abc");
    assert.equal(truncate("abcd", 3), "abc\n...[truncated 1 characters]");
  });
});

describe("resultsEnd", () => {
  it("finds the end of a results block, before the user's own text", async () => {
    const { resultsEnd } = await import("./protocol.ts");
    const msg = formatResults(
      [
        { tool: "a", ok: true, text: "x\n```\ny" },
        { tool: "b", ok: false, text: "z" },
      ],
      10000,
    ).split("\n");
    assert.equal(resultsEnd(msg, 0), msg.length);
    const withDraft = [...msg, "", "my own text"];
    assert.equal(resultsEnd(withDraft, 0), msg.length);
    assert.equal(resultsEnd(["[MCP Bridge · results]", "#1 a → ok"], 0), 2);
  });
});
