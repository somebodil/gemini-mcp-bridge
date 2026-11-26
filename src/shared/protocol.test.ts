import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  argumentsText,
  buildInstructions,
  buildToolsUpdate,
  describeTool,
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
    assert.deepEqual(parseCalls(['{"tool": "x"}', "print('hi')", "the mcp_call blocks", "mcp_call", '{"kind": "mcp_call", "n": {}}', "d = {}\nd['mcp_call'] = 1"]), { calls: [], problems: [] });
  });

  it("accepts the near misses of the shape, in JSON that JSON.parse reads", () => {
    const r = parseCalls([
      '{"mcp_call": {"name": "a", "args": {"x": 1}}}',
      '{"mcp_call": {"tool": "b", "arguments": "{\\"y\\": 2}"}}',
      'json\n[{"mcp_call": {"tool": "c"}}]',
      '{\n  "mcp_call" : {"tool": "d"}\n}',
    ]);
    assert.deepEqual(r.calls, [
      { tool: "a", arguments: { x: 1 } },
      { tool: "b", arguments: { y: 2 } },
      { tool: "c", arguments: {} },
      { tool: "d", arguments: {} },
    ]);
  });

  it("reports blocks it cannot read so that Gemini can retry", () => {
    const r = parseCalls(['{"mcp_call": {"tool": "a", "arguments": {"x": }}}', '{"mcp_call": {"arguments": {}}}', '{"mcp_call": []}', '{"id": 1, "mcp_call": {"tool": "e"}}']);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(
      r.problems.map((p) => p.error.replace(/^(JSON\.parse cannot read the call): .*/s, "$1")),
      ["JSON.parse cannot read the call", '"mcp_call" has no "tool" name.', '"mcp_call" must be an object with "tool" and "arguments".', '"mcp_call" must open its object, as its only key.'],
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

  it("reads braces and the key inside strings as text", () => {
    const block = String.raw`{"mcp_call": {"tool": "write_file", "arguments": {"path": "a.md", "content": "} {\"mcp_call\": {} {"}}}`;
    assert.deepEqual(parseCalls([block]), { calls: [{ tool: "write_file", arguments: { path: "a.md", content: '} {"mcp_call": {} {' } }], problems: [] });
  });

  it("reads nothing after a call it cannot read: the rest may be that call's", () => {
    const r = parseCalls(['{"mcp_call": {"tool": "write_file", "arguments": {"path" "a.js", "content": "const d = {};"}}}']);
    assert.deepEqual([r.calls.length, r.problems.length], [0, 1]);
    assert.match(r.problems[0].error, /^JSON\.parse cannot read the call: /);
    // a call written into a file with its double quotes left bare: the call in its content is not run
    const inner = parseCalls(['{"mcp_call": {"tool": "write_file", "arguments": {"path": "x.md", "content": "run {"mcp_call": {"tool": "run_command", "arguments": {"command": "rm -rf x"}}}"}}}']);
    assert.deepEqual([inner.calls.length, inner.problems.length], [0, 1]);
    // the broken one of two calls in a block, shown from where it starts
    const two = parseCalls(['{"mcp_call": {"tool": "a"}}\n{"mcp_call": {"tool": "b", "arguments": {"x" "y", "z": {}}}}']);
    assert.deepEqual(two.calls, [{ tool: "a", arguments: {} }]);
    assert.equal(two.problems.length, 1);
    assert.match(two.problems[0].snippet, /^\{"mcp_call": \{"tool": "b"/);
  });

  it("reports a call written with single or curly quotes, in a block and in plain text", () => {
    for (const [open, close] of ["''", "\u2018\u2019", "\u201c\u201d"]) {
      const q = (s: string) => `${open}${s}${close}`;
      const written = `{${q("mcp_call")}: {${q("tool")}: ${q("b")}}}`;
      assert.match(parseCalls([written]).problems[0]?.error ?? "", /^JSON\.parse cannot read the call: /, written);
      assert.match(parseCalls([], `Sure. ${written}`).problems[0]?.error ?? "", /^JSON\.parse cannot read the call: /, written);
    }
  });

  it("takes the key in plain text that does not open an object as a mention", () => {
    assert.deepEqual(parseCalls([], 'Each block holds {"a": 1, "mcp_call": ...}, as I said.'), { calls: [], problems: [] });
  });

  it("reads arguments written as a JSON string with JSON.parse too", () => {
    const asString = (inner: string) => `{"mcp_call": {"tool": "write_file", "arguments": ${JSON.stringify(inner)}}}`;
    assert.deepEqual(parseCalls([asString('{"path": "a.py", "content": "line1\\nline2"}')]).calls[0]?.arguments, { path: "a.py", content: "line1\nline2" });
    // a line break escaped once only: a raw line break inside the inner JSON
    assert.match(
      parseCalls([asString('{"path": "a.py", "content": "line1\nline2"}')]).problems[0]?.error ?? "",
      /^"arguments" of write_file is a string that JSON\.parse cannot read \(.+\): write the arguments as an object\.$/,
    );
    assert.match(parseCalls([asString("{not json")]).problems[0]?.error ?? "", /is a string that JSON\.parse cannot read/);
  });

  it("reports a backspace or a form feed in an argument: JSON's \\b and \\f, written for a regex's \\b", () => {
    const r = parseCalls([String.raw`{"mcp_call": {"tool": "run_command", "arguments": {"command": "grep -E '\bword\b' f"}}}`]);
    assert.deepEqual(r.calls, []);
    assert.match(r.problems[0]?.error ?? "", /^"command" holds a backspace or a form feed: .* write \\\\b\. In a JSON string/);
    assert.match(parseCalls([String.raw`{"mcp_call": {"tool": "t", "arguments": {"o": {"list": ["a", "\f"]}}}}`]).problems[0]?.error ?? "", /^"o\.list\.1" holds/);
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
    assert.equal(looksLikeCall("{'mcp_call': {}}"), true);
    assert.equal(looksLikeCall("{\u2018mcp_call\u2019: {}}"), true);
    assert.equal(looksLikeCall("the mcp_call blocks"), false);
    assert.equal(looksLikeCall("log({'event': 'mcp_call:done'})"), false);
    assert.equal(looksLikeCall('"mcp_call" without an object'), false);
  });

  it("is not stopped by a brace that never closes", () => {
    const text = 'Here is a set { like this. {"mcp_call": {"tool": "a"}}';
    assert.deepEqual(parseCalls([], text).calls, [{ tool: "a", arguments: {} }]);
    assert.deepEqual(parseCalls([text]).calls, [{ tool: "a", arguments: {} }]);
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

// ---------------------------------------------------------------------------------------------------------
// Backslashes, quotes and line breaks: JSON that JSON.parse reads reaches the tool as meant, other JSON is reported

/** Commands as they should reach the shell, each copied from a terminal. */
const COMMANDS = [
  String.raw`grep -rn "TODO" src/`,
  String.raw`grep -E '\bfoo\b|\d+\s*\w+' file.txt`,
  String.raw`sed 's/\(.*\)/[\1]/p' in.txt`,
  String.raw`sed -E 's/([0-9]+)\.([0-9]+)/\2.\1/g' versions.txt`,
  String.raw`printf 'a\tb\n'`,
  String.raw`echo $'line1\nline2'`,
  String.raw`echo -e "col1\tcol2\r"`,
  String.raw`find . -name '*.log' -exec rm {} \;`,
  String.raw`awk -F'\t' '{print $1 "\t" $2}' data.tsv`,
  String.raw`ls C:\Users\new\table`,
  String.raw`cat \\server\share\file`,
  String.raw`echo "it's" 'say "hi"' "a \"quoted\" word"`,
  String.raw`echo 'it'\''s'`,
  "echo $HOME $(whoami) `date` ${PATH%%:*}",
  String.raw`echo \$HOME \`not run\``,
  String.raw`curl -s 'https://example.com/a?b=1&c=2' | jq '.items[] | {name: .name}'`,
  String.raw`printf '%s %d%%\n' x 5`,
  "echo 한글 ✓ 😀",
  String.raw`echo '{"key": "value", "n": [1, 2], "esc": "a\"b"}' | jq .`,
  String.raw`perl -pe 's/\s+$//' f`,
  String.raw`echo trailing\\`,
  String.raw`echo one\
two`,
  "cat <<'EOF' > /tmp/x.txt\nline one\n  indented\tline\nEOF",
  String.raw`tr -d '\r' < in > out`,
  String.raw`grep -P '\x41\u0041\/' f`,
  String.raw`python3 -c 'import sys; print(sys.argv[1:])' "a b" \"c\"`,
  String.raw`git log --format='%H %s' -- 'dir with spaces/'`,
  String.raw`echo }{ "}" '{' \{`,
];

const call = (command: string) => ({ mcp_call: { tool: "run_command", arguments: { command } } });
/** As Gemini writes it when it forgets that JSON doubles backslashes: only the double quotes escaped. */
const naive = (command: string) => `{"mcp_call": {"tool": "run_command", "arguments": {"command": "${command.replaceAll('"', '\\"')}"}}}`;
const commandOf = (block: string) => parseCalls([block]).calls[0]?.arguments.command;

describe("escapes", () => {
  it("gets every command back exactly from correct JSON, compact or indented", () => {
    for (const command of COMMANDS) {
      assert.equal(commandOf(JSON.stringify(call(command))), command, command);
      assert.equal(commandOf(JSON.stringify(call(command), null, 2)), command, command);
    }
  });

  it("keeps the valid escapes as JSON means them", () => {
    const block = String.raw`{"mcp_call": {"tool": "t", "arguments": {"s": "q\"q \\ \/ \n \r \t \u00e9 \uD83D\uDE00 \u0041"}}}`;
    assert.equal(parseCalls([block]).calls[0]?.arguments.s, 'q"q \\ / \n \r \t é 😀 A');
  });

  it("gets random strings back exactly from JSON.stringify", () => {
    // every kind of character Gemini puts in an argument, but a backspace or form feed (reported, see above)
    const alphabet = ["\\", '"', "'", "/", "b", "f", "n", "r", "t", "u", "0", "A", "{", "}", "[", "]", ",", ":", " ", "\n", "\t", "\r", "$", "`", "한", "😀", "\u0001", "\u007f", "\u2028"];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 500; k++) {
      let s = "";
      for (let i = rand(40); i > 0; i--) s += alphabet[rand(alphabet.length)];
      const args = { s, nested: { list: [s, 1, true, null] } };
      const block = JSON.stringify({ mcp_call: { tool: "t", arguments: args } }, null, k % 2 ? 2 : undefined);
      assert.deepEqual(parseCalls([block]).calls[0]?.arguments, args, JSON.stringify(s));
    }
  });

  it("reports what JSON.parse does not read, with its error and how to write it", () => {
    const hint = / In a JSON string, write each backslash as \\\\, each double quote as \\", each line break as \\n and each tab as \\t\.$/;
    const cases: [string, RegExp][] = [
      // a backslash not doubled
      [naive(String.raw`grep -E '\d+' f`), /Bad escaped character/],
      [naive(String.raw`ls C:\Users\me`), /Bad escaped character/],
      // a line break or a tab as it is, not \n or \t
      [naive("cat <<'EOF' > a.py\nprint(1)\nEOF"), /Bad control character/],
      [naive("printf 'a\tb'"), /Bad control character/],
      // a double quote not escaped
      ['{"mcp_call": {"tool": "run_command", "arguments": {"command": "echo "hi""}}}', /./],
      // a trailing comma, a comment, single quotes (in the values, and around the key too)
      ['{"mcp_call": {"tool": "a", "arguments": {},}}', /./],
      ['{"mcp_call": {\n  // list it\n  "tool": "a"}}', /./],
      ["{\"mcp_call\": {'tool': 'a'}}", /./],
      ["{'mcp_call': {'tool': 'a'}}", /Expected property name/],
      // cut off
      ['{"mcp_call": {"tool": "run_command", "arguments": {"command": "ls', /Unterminated string/],
    ];
    for (const [block, why] of cases) {
      const r = parseCalls([block]);
      assert.deepEqual(r.calls, [], block);
      assert.match(r.problems[0]?.error ?? "", /^JSON\.parse cannot read the call: /, block);
      assert.match(r.problems[0].error, why, block);
      assert.match(r.problems[0].error, hint, block);
    }
    assert.match(parseCalls([cases[4][0]]).problems[0].snippet, /echo "hi"/);
  });

  it("reads a command whose backslashes were not doubled only as JSON means it", () => {
    // \t and \n are escapes of JSON: printf prints the same either way
    assert.equal(commandOf(naive(String.raw`printf 'a\tb\n'`)), "printf 'a\tb\n'");
  });

  it("asks Gemini for JSON that JSON.parse reads, with examples that are valid themselves", () => {
    const text = buildInstructions([readFile]);
    assert.match(text, /- The block must be JSON that JSON\.parse reads as it is: nothing in it is fixed for you/);
    assert.match(text, /In a JSON string, write each backslash as \\\\, each double quote as \\", each line break as \\n and each tab as \\t\. So no string spans lines\./);
    const command = /the command (.+) is written (".+")\.$/m.exec(text);
    assert.ok(command);
    assert.equal(JSON.parse(command[2]), command[1]);
    assert.equal(command[1], `grep -E '\\bword\\b' "my file"`);
    const lines = /the two lines (.+) and (.+) are one string: (".+")\.$/m.exec(text);
    assert.ok(lines);
    assert.equal(JSON.parse(lines[3]), `${lines[1]}\n${lines[2]}`);
  });

  it("asks Gemini to keep commands to the shell's syntax", () => {
    assert.match(buildInstructions([readFile]), /command line takes only the syntax of that shell.*never Python or the code of another language as commands\./);
    assert.match(buildInstructions([readFile]), /save it to a file first \(with a here-document in the command line, or a tool that writes files\), then run that file: both can go in one command\./);
  });
});

describe("arguments on the card", () => {
  it("shows strings as the tool gets them, so that a command copied from the card runs the same", () => {
    assert.equal(argumentsText({ command: String.raw`grep -E '\bfoo\b' "a b"`, cwd: "/tmp" }), String.raw`command: grep -E '\bfoo\b' "a b"` + "\ncwd: /tmp");
    assert.equal(argumentsText({ command: "cat <<'EOF'\nx\tz\nEOF" }), "command:\ncat <<'EOF'\nx\tz\nEOF");
  });

  it("shows other values as JSON, and nothing for no arguments", () => {
    assert.equal(argumentsText({ n: 3, ok: false, list: [1, "a"], o: { x: null } }), 'n: 3\nok: false\nlist: [\n  1,\n  "a"\n]\no: {\n  "x": null\n}');
    assert.equal(argumentsText({}), "");
    assert.equal(argumentsText(undefined), "");
    assert.equal(argumentsText("text"), '"text"');
  });

  it("shows control characters, a backspace above all, by their code", () => {
    assert.equal(argumentsText({ command: "a\bb\fc\rd\u0000e\u007ff\tg" }), "command: a\\u{8}b\\u{C}c\\u{D}d\\u{0}e\\u{7F}f\tg");
  });
});
