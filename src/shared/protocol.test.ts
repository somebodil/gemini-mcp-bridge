import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInstructions,
  buildToolsUpdate,
  describeTool,
  extractObjects,
  formatResults,
  looksLikeCall,
  MARK,
  parseCalls,
  resultsEnd,
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
  it("finds the end of a results block, before the user's own text", () => {
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

describe("more of the parser", () => {
  it("tells a call from a mention", () => {
    assert.equal(looksLikeCall('{"mcp_call": {}}'), true);
    assert.equal(looksLikeCall("{\u201cmcp_call\u201d: {}}"), true);
    assert.equal(looksLikeCall("the mcp_call blocks"), false);
    assert.equal(looksLikeCall('"mcp_call" without an object'), false);
  });

  it("is not stopped by a brace that never closes", () => {
    const text = 'Here is a set { like this. {"mcp_call": {"tool": "a"}}';
    assert.deepEqual(parseCalls([], text).calls, [{ tool: "a", arguments: {} }]);
    assert.deepEqual(parseCalls([text]).calls, [{ tool: "a", arguments: {} }]);
  });

  it("finds a call without a fence written with curly quotes", () => {
    const text = "Sure. {\u201cmcp_call\u201d: {\u201ctool\u201d: \u201cb\u201d}}";
    assert.deepEqual(parseCalls([], text).calls, [{ tool: "b", arguments: {} }]);
  });
});

describe("more of the instructions", () => {
  it("writes unions, nullable types and nested limits", () => {
    const tool = {
      name: "t",
      inputSchema: {
        type: "object",
        properties: {
          a: { anyOf: [{ type: "string" }, { type: "number" }] },
          b: { oneOf: [{ type: "boolean" }, { enum: ["x"] }] },
          c: { type: ["string", "null"] },
          d: { type: "object", properties: { e: { type: "object", properties: { f: { type: "string" } } } } },
          g: { type: "array", items: { type: "array", items: { type: "integer" } } },
        },
      },
    };
    assert.equal(describeTool(tool)[1], '  arguments: {"a"?: string | number, "b"?: boolean | "x", "c"?: string, "d"?: {"e"?: object}, "g"?: integer[][]}');
  });

  it("cuts long descriptions to one line of 400 characters", () => {
    const line = describeTool({ name: "t", description: "word ".repeat(200) })[0];
    assert.ok(line.endsWith("..."), line.slice(-20));
    assert.equal(line.length, "- t: ".length + 400);
  });

  it("shows the example with list_directory, or another tool that lists or reads", () => {
    assert.match(buildInstructions([{ name: "list_directory", inputSchema: { required: ["path"] } }]), /"tool": "list_directory", "arguments": \{"path":"~\/Documents"\}/);
    assert.match(buildInstructions([{ name: "search_web", inputSchema: { required: ["query"] } }]), /"tool": "search_web", "arguments": \{"query":"\.\.\."\}/);
    assert.doesNotMatch(buildInstructions([{ name: "ping" }]), /An example/);
  });

  it("changes its hash when a schema changes", () => {
    const a = [{ name: "t", inputSchema: { properties: { x: { type: "string" } } } }];
    const b = [{ name: "t", inputSchema: { properties: { x: { type: "number" } } } }];
    assert.notEqual(toolsHash(a), toolsHash(b));
  });
});

describe("more of the results", () => {
  it("keeps a floor per result when many share a small budget", () => {
    const s = formatResults(
      Array.from({ length: 10 }, (_, i) => ({ tool: `t${i}`, ok: true, text: "y".repeat(500) })),
      1000,
    );
    assert.equal((s.match(/\.\.\.\[truncated 400 characters\]/g) ?? []).length, 10);
  });

  it("ends a results block whose fence is missing at the next line", () => {
    assert.equal(resultsEnd(["[MCP Bridge · results]", "#1 a → ok", "plain"], 0), 2);
    assert.equal(resultsEnd(["[MCP Bridge · results]", "#1 a → ok", "```text", "x"], 0), 4);
  });

  it("summarizes nothing when there is no result line", () => {
    assert.equal(summarizeResults("[MCP Bridge · results]\nno lines"), "");
  });
});
