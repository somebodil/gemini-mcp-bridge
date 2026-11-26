import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  argumentsText,
  buildInstructions,
  buildToolsUpdate,
  describeTool,
  extractObjects,
  formatResults,
  looksLikeCall,
  MARK,
  parseCalls,
  repairEscapes,
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
      r.problems.map((p) => p.error.replace(/^(The block is not valid JSON) \(.*/s, "$1")),
      ["The block is not valid JSON", '"mcp_call" has no "tool" name.', '"mcp_call" must be an object with "tool" and "arguments".'],
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

  it("reports a broken call even when an object inside it can be read, such as a {} in its code", () => {
    const r = parseCalls(['{"mcp_call": {"tool": "write_file", "arguments": {"path" "a.js", "content": "const d = {};"}}}']);
    assert.equal(r.calls.length, 0);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0].error, /^The block is not valid JSON \(/);
    // an object that only names the key as a value is not a call: nothing to report
    assert.deepEqual(parseCalls(['{"kind": "mcp_call", "n": {}}']), { calls: [], problems: [] });
    // the broken one of two calls in a block, shown from where it starts
    const two = parseCalls(['{"mcp_call": {"tool": "a"}}\n{"mcp_call": {"tool": "b", "arguments": {"x" "y", "z": {}}}}']);
    assert.deepEqual(two.calls, [{ tool: "a", arguments: {} }]);
    assert.equal(two.problems.length, 1);
    assert.match(two.problems[0].snippet, /^\{"mcp_call": \{"tool": "b"/);
    assert.match(two.problems[0].error, /^The block is not valid JSON \(.*JSON/);
  });

  it("reads code whose double quotes were not escaped, across lines and with braces", () => {
    const code = 'const d = {};\nconsole.log("hi", d);\nprint("a", "b")\nm = {"k": [1, "x"]}\n<div class="c">"</div>\nprint("}}}")\n';
    const block = `{"mcp_call": {"tool": "write_file", "arguments": {"path": "a.js", "content": "${code}"}}}`;
    assert.deepEqual(parseCalls([block]).calls, [{ tool: "write_file", arguments: { path: "a.js", content: code } }]);
    // indented, and the next call after it
    const indented = `{\n  "mcp_call": {\n    "tool": "write_file",\n    "arguments": {\n      "path": "b.txt",\n      "content": "say "hi""\n    }\n  }\n}`;
    assert.deepEqual(parseCalls([indented]).calls[0]?.arguments, { path: "b.txt", content: 'say "hi"' });
    assert.deepEqual(
      parseCalls([`${block}\n{"mcp_call": {"tool": "list_directory", "arguments": {"path": "."}}}`]).calls.map((c) => c.tool),
      ["write_file", "list_directory"],
    );
  });

  it("does not guess where bare double quotes could end the value in more than one place: it reports the call", () => {
    for (const content of [
      // code that goes on after a quote, a comma and a word in quotes
      'd = {"a": "x", "b": "y"}',
      'd = {"a": "x", "b": 1}',
    ]) {
      const r = parseCalls([`{"mcp_call": {"tool": "write_file", "arguments": {"path": "a.py", "content": "${content}"}}}`]);
      assert.deepEqual([r.calls.length, r.problems.length], [0, 1], content);
    }
    // a value with bare quotes that another key follows
    const r = parseCalls(['{"mcp_call": {"tool": "write_file", "arguments": {"content": "say "hi"", "path": "b.txt"}}}']);
    assert.deepEqual([r.calls.length, r.problems.length], [0, 1]);
  });

  it("reads arguments written as a JSON string like the call itself: line breaks and backslashes as they are", () => {
    const asString = (inner: string) => `{"mcp_call": {"tool": "write_file", "arguments": ${JSON.stringify(inner)}}}`;
    // the line break escaped once only: a raw line break inside the inner JSON
    assert.deepEqual(parseCalls([asString('{"path": "a.py", "content": "line1\nline2"}')]).calls[0]?.arguments, { path: "a.py", content: "line1\nline2" });
    assert.deepEqual(parseCalls([asString(String.raw`{"command": "grep '\d+' f"}`)]).calls[0]?.arguments, { command: String.raw`grep '\d+' f` });
    assert.match(parseCalls([asString("{not json")]).problems[0]?.error ?? "", /is a string that is not JSON/);
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

// ---------------------------------------------------------------------------------------------------------
// Backslashes, quotes and line breaks: what Gemini writes into a JSON string must reach the tool as meant

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
/** A backslash that JSON reads as an escape: such a command cannot be told from its naive writing. */
const ambiguous = (command: string) => /\\(["\\/nrt]|u[0-9a-fA-F]{4})/.test(command);

describe("escapes", () => {
  it("gets every command back exactly from correct JSON, compact or indented", () => {
    for (const command of COMMANDS) {
      assert.equal(commandOf(JSON.stringify(call(command))), command, command);
      assert.equal(commandOf(JSON.stringify(call(command), null, 2)), command, command);
    }
  });

  it("gets the command back when Gemini did not double its backslashes, wherever that is unambiguous", () => {
    const clear = COMMANDS.filter((c) => !ambiguous(c));
    assert.ok(clear.length >= 12, `${clear.length} commands`);
    for (const command of clear) assert.equal(commandOf(naive(command)), command, command);
  });

  it("reads \\b and \\f as a backslash and the letter: a regex word boundary, not a backspace", () => {
    assert.equal(commandOf(naive(String.raw`grep -E '\bfoo\b'`)), String.raw`grep -E '\bfoo\b'`);
    assert.equal(commandOf(naive(String.raw`printf '\f'`)), String.raw`printf '\f'`);
    assert.equal(repairEscapes(String.raw`{"a": "\b\f"}`), String.raw`{"a": "\\b\\f"}`);
    // written correctly, it stays as it is
    assert.equal(repairEscapes(String.raw`{"a": "\\b\\f"}`), String.raw`{"a": "\\b\\f"}`);
  });

  it("keeps the JSON meaning of \\n, \\t and \\r when they are not doubled", () => {
    // printf and $'...' print the same either way; a JSON line break is what a write_file content needs
    assert.equal(commandOf(naive(String.raw`printf 'a\tb\n'`)), "printf 'a\tb\n'");
    assert.equal(commandOf(naive(String.raw`tr -d '\r'`)), "tr -d '\r'");
  });

  it("keeps the valid escapes as JSON means them", () => {
    const block = String.raw`{"mcp_call": {"tool": "t", "arguments": {"s": "q\"q \\ \/ \n \r \t \u00e9 \uD83D\uDE00 \u0041"}}}`;
    assert.equal(parseCalls([block]).calls[0]?.arguments.s, 'q"q \\ / \n \r \t é 😀 A');
  });

  it("reads every other backslash as itself", () => {
    const cases: [string, string][] = [
      [String.raw`"\d \s \w \. \( \) \[ \{ \$ \* \+ \? \| \^ \- \' \; \&"`, String.raw`\d \s \w \. \( \) \[ \{ \$ \* \+ \? \| \^ \- \' \; \&`],
      [String.raw`"C:\Users\Admin\Desktop"`, String.raw`C:\Users\Admin\Desktop`],
      [String.raw`"\u12 \uZZZZ \U0041 \x41 \0 \1"`, String.raw`\u12 \uZZZZ \U0041 \x41 \0 \1`],
      [String.raw`"한\글 \😀"`, String.raw`한\글 \😀`],
    ];
    for (const [json, value] of cases) assert.equal(JSON.parse(repairEscapes(json)), value, json);
  });

  it("writes raw line breaks, tabs and control characters inside strings as escapes, and leaves the rest alone", () => {
    assert.equal(repairEscapes('{"a": "x\ny\tz\r\u0001"}'), '{"a": "x\\ny\\tz\\r\\u0001"}');
    const outside = '{\n\t"a" :\r\n "b" }';
    assert.equal(repairEscapes(outside), outside);
    // a backslash before a raw line break: a shell line continuation
    assert.equal(JSON.parse(repairEscapes('"one \\\ntwo"')), "one \\\ntwo");
    // a backslash at the very end
    assert.equal(repairEscapes('"a\\'), '"a\\\\');
  });

  it("reads a file content written across lines, with escapes and naive backslashes mixed", () => {
    const content = "import re\n\nprint(re.findall(r'\\d+\\.\\d+', \"v1.2 v3.4\"))\n\tdone\n";
    // across lines, naive backslashes
    const raw = `{"mcp_call": {"tool": "write_file", "arguments": {"path": "/tmp/a.py", "content": "${content.replaceAll('"', '\\"')}"}}}`;
    assert.equal(parseCalls([raw]).calls[0]?.arguments.content, content);
    // \n escapes for the line breaks, and the regex backslashes still single
    const mixed = raw.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    assert.equal(parseCalls([mixed]).calls[0]?.arguments.content, content);
  });

  it("takes some backslashes doubled and others not in one string", () => {
    assert.equal(commandOf(String.raw`{"mcp_call": {"tool": "run_command", "arguments": {"command": "grep -c '\\d' a && grep -c '\d' b"}}}`), String.raw`grep -c '\d' a && grep -c '\d' b`);
  });

  it("repairs the escapes together with the other slips", () => {
    const block = "{“mcp_call”: {“tool”: “run_command”, “arguments”: {“command”: “grep -E '\\bx\\b' f”,},}}";
    assert.equal(commandOf(block), String.raw`grep -E '\bx\b' f`);
  });

  it("gets random strings back exactly from JSON.stringify", () => {
    // every kind of character Gemini puts in an argument, but a backspace or form feed (read as \b and \f)
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

  it("says how to write it when the JSON is broken", () => {
    const hint = /\. In a JSON string, write each backslash as \\\\, each double quote as \\", and each line break as \\n\.$/;
    const unescaped = parseCalls(['{"mcp_call": {"tool": "run_command", "arguments": {"command": "echo "hi"", "n": }}}']).problems[0];
    assert.match(unescaped.error, /^The block is not valid JSON \(.*JSON.*\)/);
    assert.match(unescaped.error, hint);
    assert.match(unescaped.snippet, /echo "hi"/);
    const cut = parseCalls(['{"mcp_call": {"tool": "run_command", "arguments": {"command": "ls']).problems[0];
    assert.match(cut.error, /^The block is not valid JSON \(a \{ or a string is never closed\)/);
    assert.match(cut.error, hint);
  });

  it("asks Gemini for valid JSON with doubled backslashes, with an example that is valid itself", () => {
    const text = buildInstructions([readFile]);
    assert.match(text, /write each backslash as \\\\, each double quote as \\", and each line break as \\n\./);
    const example = /the command (.+) is written (".+")\.$/m.exec(text);
    assert.ok(example);
    assert.equal(JSON.parse(example[2]), example[1]);
    assert.equal(example[1], `grep -E '\\bword\\b' "my file"`);
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
