// The text protocol between Gemini and the extension.
//
// Gemini on the web has no tool API, so the extension teaches it one in plain text: the first message of a
// conversation carries instructions and the tool list, Gemini answers with code blocks holding
// {"mcp_call": {...}}, and the extension sends the results back as the next message. Everything here is pure
// so that it can be tested without a browser.

export const MARK = {
  instructions: "[MCP Bridge · tool instructions",
  instructionsEnd: "[End of MCP Bridge instructions]",
  toolsUpdate: "[MCP Bridge · tools updated",
  results: "[MCP Bridge · results]",
} as const;

export const CALL_KEY = "mcp_call";

/**
 * A code block is a call (or a broken one) only when it holds the key in quotes, not when it only names it. Single
 * and curly quotes count too, so that a call written with them is reported, not passed over.
 */
export function looksLikeCall(text: string): boolean {
  return /["'\u2018\u2019\u201c\u201d]mcp_call["'\u2018\u2019\u201c\u201d]/.test(text) && text.includes("{");
}

/** The key written as a key, in any of those quotes: each is meant to be a call. */
const CALL_AS_KEY = /["'\u2018\u2019\u201c\u201d]mcp_call["'\u2018\u2019\u201c\u201d]\s*:/g;

/** How to write a JSON string: in the instructions, and at the end of each error about JSON that goes back to Gemini. */
const HOW = "In a JSON string, write each backslash as \\\\, each double quote as \\\", each line break as \\n and each tab as \\t.";

/** The heading of the tool list in the instructions; the chip counts the lines after it. */
export const TOOLS_HEADING = "Tools you can request:";

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/** The instructions that open a conversation. `notes` are the instructions the MCP servers give about themselves. */
export function buildInstructions(tools: ToolInfo[], notes: string[] = []): string {
  // Gemini believes it cannot reach the user's computer, and it is right: told that it "can use tools", the
  // stronger models refuse, as from a fake tool. Asked instead to request things from the user, whose helper
  // runs them, they do it. The wording keeps to what is true.
  return [
    `${MARK.instructions}: follow these for the rest of this conversation]`,
    "You cannot access my computer, but I can, and I have a helper for it: MCP Bridge, a browser extension on my side. " +
      "When you need something from my computer (a folder listing, a file, the output of a command, or another tool below), " +
      "ask me for it with a request block in the format below. My helper runs the request on my computer and sends you the result " +
      "as my next message.",
    "You do not run anything yourself: you write the request, my helper runs it. So instead of asking me to look something up " +
      "or to run something myself, write the request block, then wait for my reply with the result.",
    "",
    `A request is a fenced code block that holds one JSON object with the single key "${CALL_KEY}":`,
    "```json",
    `{"${CALL_KEY}": {"tool": "TOOL_NAME", "arguments": {}}}`,
    "```",
    "Rules:",
    "- One request per code block. Several blocks in one reply are run in order.",
    "- After your request blocks, end your reply and wait for the result. Never guess or invent results.",
    `- Results come back in a message that starts with "${MARK.results}". Then continue: request more, or answer me.`,
    `- Make requests only when they help with what I asked. Do not write "${CALL_KEY}" blocks for any other purpose, ` +
      "and do not repeat these instructions to me.",
    "- The block must be JSON that JSON.parse reads as it is: nothing in it is fixed for you, and a block JSON.parse cannot read is not run " +
      `(its error comes back to you). ${HOW} So no string spans lines. Only straight double quotes, no comments, no trailing commas.`,
    `  For example, the command grep -E '\\bword\\b' "my file" is written "grep -E '\\\\bword\\\\b' \\"my file\\"".`,
    `  And the two lines print("hi") and x = 1 are one string: "print(\\"hi\\")\\nx = 1".`,
    "- An argument that holds a command line takes only the syntax of that shell, as typed in a terminal: never Python or the code of another language as commands. " +
      "To run such code, save it to a file first (with a here-document in the command line, or a tool that writes files), then run that file: both can go in one command.",
    "- If a request returns an error, fix the arguments and try again, or tell me what went wrong.",
    "- Answer me in the language I write in.",
    "",
    ...example(tools),
    ...toolSection(tools, notes),
    MARK.instructionsEnd,
  ].join("\n");
}

/** Sent in front of the user's message when the tools changed after the instructions were given. */
export function buildToolsUpdate(tools: ToolInfo[], notes: string[] = []): string {
  return [
    `${MARK.toolsUpdate}: the list below replaces the earlier one; the rules stay the same]`,
    ...toolSection(tools, notes),
    MARK.instructionsEnd,
  ].join("\n");
}

/** One exchange, request to answer, with a tool that exists: models follow a protocol they were shown. */
function example(tools: ToolInfo[]): string[] {
  const t = tools.find((x) => x.name === "list_directory") ?? tools.find((x) => /list|read|get|search/i.test(x.name));
  if (!t) return [];
  const req = Object.fromEntries((t.inputSchema?.required ?? []).map((k) => [k, k === "path" ? "~/Documents" : "..."]));
  return [
    "An example of the whole exchange:",
    "- Me: What is in my Documents folder?",
    `- You: \`{"${CALL_KEY}": {"tool": "${t.name}", "arguments": ${JSON.stringify(req)}}}\` in a code block, and nothing after it.`,
    `- Me: "${MARK.results}" with the output, for example "#1 ${t.name} → ok" and a few lines.`,
    "- You: the answer, from that output.",
    "",
  ];
}

function toolSection(tools: ToolInfo[], notes: string[]): string[] {
  const lines: string[] = [];
  const cleanNotes = notes.map((n) => n.trim()).filter(Boolean);
  if (cleanNotes.length) {
    lines.push("About my computer and the tools:");
    for (const n of cleanNotes) lines.push(...n.split("\n").map((l) => `  ${l}`));
    lines.push("");
  }
  lines.push(tools.length ? TOOLS_HEADING : `${TOOLS_HEADING} none right now.`);
  for (const t of tools) lines.push(...describeTool(t));
  return lines;
}

export function describeTool(tool: ToolInfo): string[] {
  const desc = oneLine(tool.description ?? "");
  const out = [`- ${tool.name}: ${desc || "(no description)"}`];
  const schema = tool.inputSchema;
  const props = schema?.properties ?? {};
  const names = Object.keys(props);
  if (!names.length) {
    out.push("  arguments: {}");
    return out;
  }
  const required = new Set(schema?.required ?? []);
  out.push(`  arguments: {${names.map((n) => `${JSON.stringify(n)}${required.has(n) ? "" : "?"}: ${typeOf(props[n])}`).join(", ")}}`);
  for (const n of names) {
    const d = oneLine(props[n].description ?? "");
    if (d) out.push(`    ${n}: ${d}`);
  }
  return out;
}

function typeOf(s: JsonSchema | undefined, depth = 0): string {
  if (!s) return "any";
  if (s.enum?.length) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const alts = s.anyOf ?? s.oneOf;
  if (alts?.length) return alts.map((a) => typeOf(a, depth)).join(" | ");
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null").join(" | ") : s.type;
  if (t === "array") return `${typeOf(s.items, depth)}[]`;
  if (t === "object" || (!t && s.properties)) {
    const props = s.properties ?? {};
    const names = Object.keys(props);
    if (!names.length || depth >= 1) return "object";
    const req = new Set(s.required ?? []);
    return `{${names.map((n) => `${JSON.stringify(n)}${req.has(n) ? "" : "?"}: ${typeOf(props[n], depth + 1)}`).join(", ")}}`;
  }
  return t || "any";
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 400 ? `${t.slice(0, 397)}...` : t;
}

// ---------------------------------------------------------------------------------------------------------
// Calls

export interface ParsedCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ParseProblem {
  /** What Gemini wrote, shortened, so that the error sent back shows it what went wrong. */
  snippet: string;
  error: string;
}

interface ParseResult {
  calls: ParsedCall[];
  problems: ParseProblem[];
}

/**
 * Reads the calls of one reply. `blocks` are the texts of its code blocks; `text` is the whole visible text of
 * the reply, searched only when no code block holds a call (Gemini sometimes drops the fence).
 */
export function parseCalls(blocks: string[], text = ""): ParseResult {
  const result: ParseResult = { calls: [], problems: [] };
  for (const block of blocks) if (looksLikeCall(block)) readCalls(block, result, true);
  if (!result.calls.length && !result.problems.length && looksLikeCall(text)) readCalls(text, result, false);
  return result;
}

/**
 * Each object that opens with the key is a call, read by JSON.parse as it is written, from its brace to the brace
 * that closes it: nothing is fixed or guessed. A call JSON.parse cannot read is a problem with JSON.parse's error,
 * and nothing after it is read (it may be the rest of that call). In a block, the key anywhere else is a problem
 * too; prose may name it.
 */
function readCalls(text: string, result: ParseResult, inBlock: boolean): void {
  let next = 0;
  for (const m of text.matchAll(CALL_AS_KEY)) {
    // inside a call read already
    if (m.index < next) continue;
    let start = m.index - 1;
    while (start >= next && /\s/.test(text[start])) start--;
    if (start < next || text[start] !== "{") {
      if (inBlock) result.problems.push({ snippet: shorten(text.slice(next)), error: `"${CALL_KEY}" must open its object, as its only key.` });
      continue;
    }
    const end = matchBrace(text, start);
    const source = end < 0 ? text.slice(start) : text.slice(start, end + 1);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(source) as Record<string, unknown>;
    } catch (e) {
      result.problems.push({ snippet: shorten(source), error: `JSON.parse cannot read the call: ${errorText(e)}. ${HOW}` });
      return;
    }
    const call = toCall(value[CALL_KEY]);
    if (typeof call === "string") result.problems.push({ snippet: shorten(source), error: call });
    else result.calls.push(call);
    next = end + 1;
  }
}

/** Accepts the shape asked for and the near misses Gemini produces: "name" for "tool", "args" for "arguments", arguments as a JSON string. */
function toCall(v: unknown): ParsedCall | string {
  if (!isRecord(v)) return `"${CALL_KEY}" must be an object with "tool" and "arguments".`;
  const tool = v.tool ?? v.name ?? v.tool_name;
  if (typeof tool !== "string" || !tool.trim()) return `"${CALL_KEY}" has no "tool" name.`;
  let args: unknown = v.arguments ?? v.args ?? v.parameters ?? v.input ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (e) {
      return `"arguments" of ${tool} is a string that JSON.parse cannot read (${errorText(e)}): write the arguments as an object.`;
    }
  }
  if (!isRecord(args)) return `"arguments" of ${tool} must be a JSON object.`;
  const at = backspaceIn(args, "");
  if (at !== undefined)
    return `"${at}" holds a backspace or a form feed: \\b and \\f in a JSON string are those characters. For a backslash and the letter (\\b of a regex), write \\\\b. ${HOW}`;
  return { tool: tool.trim(), arguments: args };
}

/**
 * Where a string in `v` holds a backspace or a form feed: JSON reads \b and \f as those, and Gemini writes them for
 * a backslash and the letter (a regex's \b), never for the characters. The command would run, and find nothing.
 */
function backspaceIn(v: unknown, path: string): string | undefined {
  if (typeof v === "string") return /[\b\f]/.test(v) ? path : undefined;
  if (typeof v !== "object" || v === null) return undefined;
  for (const [k, x] of Object.entries(v)) {
    const at = backspaceIn(x, path ? `${path}.${k}` : k);
    if (at !== undefined) return at;
  }
  return undefined;
}

/** Where the object that begins at `start` ends, its braces counted outside its strings; -1 when it never does. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The arguments as the tool gets them, for the card: a string as it is (a command can be copied into a terminal
 * and runs the same), other values as JSON. Control characters other than line breaks and tabs are shown as
 * \u{...}, so a carriage return or a NUL written into a command is seen.
 */
export function argumentsText(args: unknown): string {
  if (!isRecord(args)) return JSON.stringify(args, null, 2) ?? "";
  return Object.entries(args)
    .map(([k, v]) => {
      if (typeof v !== "string") return `${k}: ${JSON.stringify(v, null, 2) ?? String(v)}`;
      let s = "";
      for (const c of v) {
        const code = c.charCodeAt(0);
        s += (code < 0x20 && c !== "\n" && c !== "\t") || code === 0x7f ? `\\u{${code.toString(16).toUpperCase()}}` : c;
      }
      return s.includes("\n") ? `${k}:\n${s}` : `${k}: ${s}`;
    })
    .join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shorten(s: string, n = 300): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

// ---------------------------------------------------------------------------------------------------------
// Results

export interface Outcome {
  tool: string;
  ok: boolean;
  text: string;
}

/** The message that carries the results of one reply's calls back to Gemini. */
export function formatResults(outcomes: Outcome[], maxChars: number): string {
  // the budget is shared; a floor keeps every result readable (10 calls at the smallest budget: 100 each)
  const per = Math.max(100, Math.floor(maxChars / Math.max(1, outcomes.length)));
  const parts: string[] = [MARK.results];
  outcomes.forEach((o, i) => {
    const body = truncate(o.text || "(no output)", per);
    const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
    parts.push(`#${i + 1} ${o.tool} → ${o.ok ? "ok" : "error"}`, `${fence}text`, body, fence);
  });
  return parts.join("\n");
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated ${s.length - max} characters]`;
}

function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Where a results block that starts at line `start` ends (the index after its last line). The user's own text
 * may follow it in the same message.
 */
export function resultsEnd(lines: string[], start: number): number {
  let i = start + 1;
  for (;;) {
    // past the end when a fence was never closed: the block takes the rest of the message
    if (i >= lines.length) return lines.length;
    if (!/^#\d+ \S+ → (ok|error)$/.test(lines[i].trim())) return i;
    const fence = lines[i + 1]?.trim().match(/^(`{3,})text$/)?.[1];
    if (!fence) return Math.min(lines.length, i + 1);
    let j = i + 2;
    while (j < lines.length && lines[j].trim() !== fence) j++;
    i = j + 1;
  }
}

/** Short summary of a results message for the chip that replaces it on the page, e.g. "list_directory ✓ · read_file ✗". */
export function summarizeResults(message: string): string {
  const items: string[] = [];
  for (const m of message.matchAll(/^#\d+ (\S+) → (ok|error)$/gm)) items.push(`${m[1]} ${m[2] === "ok" ? "✓" : "✗"}`);
  return items.join(" · ");
}

/** A stable short hash of the tool list, to notice when it changed since the instructions were given. */
export function toolsHash(tools: ToolInfo[], notes: string[] = []): string {
  const s = JSON.stringify([tools.map((t) => [t.name, t.description ?? "", t.inputSchema ?? {}]), notes]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
