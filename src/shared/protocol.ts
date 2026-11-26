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

/** A code block is a call (or a broken one) only when it holds the key as JSON writes it, not when it mentions it. */
export function looksLikeCall(text: string): boolean {
  return /["\u201c\u201d]mcp_call["\u201c\u201d]/.test(text) && text.includes("{");
}

/** The key written as a key: each is meant to be a call. */
const CALL_AS_KEY = /["\u201c\u201d]mcp_call["\u201c\u201d]\s*:/g;
/** A call object begins here. */
const CALL_START = /^\{\s*["\u201c\u201d]mcp_call["\u201c\u201d]\s*:/;

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
    "- The block must be valid JSON. In its strings, write each backslash as \\\\, each double quote as \\\", and each line break as \\n. " +
      `For example, the command grep -E '\\bword\\b' "my file" is written "grep -E '\\\\bword\\\\b' \\"my file\\"".`,
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
  for (const block of blocks) {
    if (!looksLikeCall(block)) continue;
    const objects = extractObjects(block);
    const before = result.calls.length + result.problems.length;
    for (const o of objects) addCall(result, o);
    const read = result.calls.length + result.problems.length - before;
    // fewer calls read than the block writes: one is not JSON, and only objects inside it were (a {} in the code of
    // an argument); no call goes without a word
    if (read < (block.match(CALL_AS_KEY)?.length ?? 0) || (!read && !objects.length)) result.problems.push(brokenCall(block));
  }
  if (!result.calls.length && !result.problems.length && looksLikeCall(text)) {
    for (const o of extractObjects(text)) addCall(result, o);
  }
  return result;
}

function addCall(result: ParseResult, o: { value: unknown; source: string }): void {
  if (!isRecord(o.value) || !(CALL_KEY in o.value)) return;
  const call = toCall(o.value[CALL_KEY]);
  if (typeof call === "string") result.problems.push({ snippet: shorten(o.source), error: call });
  else result.calls.push(call);
}

/** Accepts the shape asked for and the near misses Gemini produces: "name" for "tool", "args" for "arguments", arguments as a JSON string. */
function toCall(v: unknown): ParsedCall | string {
  if (!isRecord(v)) return `"${CALL_KEY}" must be an object with "tool" and "arguments".`;
  const tool = v.tool ?? v.name ?? v.tool_name;
  if (typeof tool !== "string" || !tool.trim()) return `"${CALL_KEY}" has no "tool" name.`;
  let args: unknown = v.arguments ?? v.args ?? v.parameters ?? v.input ?? {};
  if (typeof args === "string") {
    // read like the call itself: line breaks written as they are, backslashes as meant
    const parsed = parseLenient(args);
    if (parsed === undefined) return `"arguments" of ${tool} is a string that is not JSON.`;
    args = parsed;
  }
  if (!isRecord(args)) return `"arguments" of ${tool} must be a JSON object.`;
  return { tool: tool.trim(), arguments: args };
}

/** Finds the top-level JSON objects in a text: `{...}` balanced outside of strings, then parsed (leniently). */
export function extractObjects(text: string): { value: unknown; source: string }[] {
  const out: { value: unknown; source: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start < 0) break;
    const found = objectAt(text, start);
    // not an object from here ("a set { like this"): perhaps from the next brace
    if (!found) {
      i = start + 1;
      continue;
    }
    out.push({ value: found.value, source: text.slice(start, found.end + 1) });
    i = found.end + 1;
  }
  return out;
}

/** The JSON object that begins at `start`, read leniently; a call also with double quotes left bare in its strings. */
function objectAt(text: string, start: number): { value: unknown; end: number } | undefined {
  const end = matchBrace(text, start);
  if (end >= 0) {
    const value = parseLenient(text.slice(start, end + 1));
    if (value !== undefined) return { value, end };
  }
  if (!CALL_START.test(text.slice(start, start + 40))) return undefined;
  const loose = withBareQuotes(text, start);
  if (!loose) return undefined;
  const value = parseLenient(loose.json);
  return value === undefined ? undefined : { value, end: loose.end };
}

/** A key ahead, as the names of arguments are: a word in double quotes, then a colon. */
const KEY_AHEAD = /^"[A-Za-z_$][\w$.-]{0,100}"\s*:/;
const VALUE_START = /^["{[\-0-9tfn]/;

/**
 * Code copied into an argument without escaping its double quotes (`"content": "print("hi")"`). A double quote
 * ends a value where the JSON goes on after it: a comma and the next key (in an object) or value (in a list), or
 * the closing brackets of the call with nothing after the call but white space or the next call. The other double
 * quotes are escaped. A key ends at its next double quote.
 * Where it is not clear, nothing is guessed (the call is reported, and Gemini writes it again): a value with
 * escaped quotes in it that a comma and a key follow may be code that goes on (`{"a": "b", "c": 1}`).
 * Returns the object from `start` to its closing brace, or undefined.
 */
function withBareQuotes(text: string, start: number): { json: string; end: number } | undefined {
  const open: string[] = [];
  let out = "";
  let inString = false;
  let isKey = false;
  /** Double quotes of the current string were escaped. */
  let bare = false;
  /** The last character outside the strings that is not white space. */
  let prev = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        out += c + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (c !== '"') {
        out += c;
        continue;
      }
      const next = isKey ? "next" : goesOn(text, i + 1, open);
      if (next === "next" && bare) return undefined;
      if (next) {
        inString = false;
        out += c;
        prev = c;
      } else {
        out += '\\"';
        bare = true;
      }
      continue;
    }
    out += c;
    if (c === '"') {
      inString = true;
      bare = false;
      isKey = open.at(-1) === "{" && (prev === "{" || prev === ",");
      continue;
    }
    if (c === "{" || c === "[") open.push(c);
    else if (c === "}" || c === "]") {
      open.pop();
      if (!open.length) return { json: out, end: i };
    }
    if (!/\s/.test(c)) prev = c;
  }
  return undefined;
}

/** How the JSON goes on at `j`, after a value string that ends just before it: with the next entry, or the call ends. */
function goesOn(text: string, j: number, open: string[]): "next" | "end" | null {
  const skip = (k: number) => {
    while (k < text.length && /\s/.test(text[k])) k++;
    return k;
  };
  j = skip(j);
  for (let depth = open.length; ; ) {
    const c = text[j];
    const inner = open[depth - 1];
    if (c === ",") {
      const rest = text.slice(skip(j + 1), j + 300);
      return (inner === "{" ? KEY_AHEAD : VALUE_START).test(rest) ? "next" : null;
    }
    if (!((c === "}" && inner === "{") || (c === "]" && inner === "["))) return null;
    j = skip(j + 1);
    if (--depth === 0) return j === text.length || CALL_START.test(text.slice(j, j + 40)) ? "end" : null;
  }
}

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

function parseLenient(source: string): unknown {
  // as written, then without the usual slips; backslashes are read as meant in both
  for (const s of [source, withoutSlips(source)]) {
    try {
      return JSON.parse(repairEscapes(s));
    } catch {
      // the next way
    }
  }
  return undefined;
}

/** Trailing commas and typographic quotes, the usual slips. */
function withoutSlips(source: string): string {
  return source.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"');
}

/** The first call of a block that is not JSON (else its first object): why, and how to write it. Sent back to Gemini. */
function brokenCall(block: string): ParseProblem {
  let start = -1;
  for (let i = block.indexOf("{"); i >= 0 && start < 0; i = block.indexOf("{", i + 1))
    if (CALL_START.test(block.slice(i, i + 40)) && !objectAt(block, i)) start = i;
  if (start < 0) start = block.indexOf("{");
  const end = start < 0 ? -1 : matchBrace(block, start);
  let why = "a { or a string is never closed";
  if (end >= 0) {
    try {
      JSON.parse(repairEscapes(withoutSlips(block.slice(start, end + 1))));
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    snippet: shorten(block.slice(Math.max(start, 0))),
    error: `The block is not valid JSON (${why}). In a JSON string, write each backslash as \\\\, each double quote as \\", and each line break as \\n.`,
  };
}

/**
 * Makes Gemini's JSON say what it meant. Models copy commands, regexes and Windows paths into JSON strings
 * without doubling their backslashes. Inside strings, this
 * - keeps the escapes that are meant as escapes: \" \\ \/ \n \r \t, and \u with four hex digits;
 * - reads \b and \f as a backslash and the letter: a backspace or a form feed in an argument is never what was
 *   meant, and \b (a word boundary in a regex) is common;
 * - reads every other backslash as itself (\d, \(, \., \$, C:\Users), where JSON.parse would give up;
 * - writes raw line breaks, tabs and other control characters as escapes (a string written across lines).
 * Text outside strings stays as it is. \n, \r and \t keep their JSON meaning: they are as often meant as written.
 */
export function repairEscapes(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
    } else if (c === '"') {
      inString = false;
      out += c;
    } else if (c === "\\") {
      const next = source[i + 1] ?? "";
      if (next && '"\\/nrt'.includes(next)) {
        out += c + next;
        i++;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
        out += source.slice(i, i + 6);
        i += 5;
      } else {
        // the backslash itself; the character after it is read on its own
        out += "\\\\";
      }
    } else {
      const code = c.charCodeAt(0);
      if (code >= 0x20) out += c;
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/**
 * The arguments as the tool gets them, for the card: a string as it is (a command can be copied into a terminal
 * and runs the same), other values as JSON. Control characters other than line breaks and tabs are shown as
 * \u{...}, so a backspace that slipped into a command is seen.
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
