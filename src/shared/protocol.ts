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

const CALL_KEY = "mcp_call";

/** A code block is a call (or a broken one) only when it holds the key as JSON writes it, not when it mentions it. */
export function looksLikeCall(text: string): boolean {
  return /["\u201c\u201d]mcp_call["\u201c\u201d]/.test(text) && text.includes("{");
}

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
    if (!objects.length) {
      result.problems.push({ snippet: shorten(block), error: "The block is not valid JSON." });
      continue;
    }
    for (const o of objects) addCall(result, o);
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
    try {
      args = JSON.parse(args);
    } catch {
      return `"arguments" of ${tool} is a string that is not JSON.`;
    }
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
    const end = matchBrace(text, start);
    // a brace that never closes ("a set { like this") hides nothing after it
    if (end < 0) {
      i = start + 1;
      continue;
    }
    const source = text.slice(start, end + 1);
    const value = parseLenient(source);
    if (value !== undefined) {
      out.push({ value, source });
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return out;
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
  try {
    return JSON.parse(source);
  } catch {
    // trailing commas and typographic quotes are the usual slips
    const fixed = source.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"');
    try {
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
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
