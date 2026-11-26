// Everything the extension knows about the page of gemini.google.com. When Gemini changes its page, this is
// the file to change. Selectors avoid text (the page is in the user's language) and prefer Gemini's own
// element names and test ids.
//
// Which reply is handled: only the answer to a message this tab sent. When a message goes out, the extension
// notes which replies are on the page already (none of them is the answer) and what the message says; the
// answer is the first new reply that directly follows that message. Opening an old conversation, reloading,
// or switching chats therefore never runs the calls on the page.

import { t } from "../shared/i18n.ts";
import { looksLikeCall, MARK, parseCalls, resultsEnd, summarizeResults, TOOLS_HEADING } from "../shared/protocol.ts";
import { problem } from "../shared/report.ts";
import { caretToStart, dbg, selectAllIn, sleep, type Finished, type Item, type Page, type Progress } from "./page.ts";
import { Card, collapse } from "./ui.ts";

const SEL = {
  editor: "rich-textarea .ql-editor",
  /** The send button's wrapper carries `submit` when it sends and `stop` while Gemini writes. */
  sendWrapper: ".send-button",
  sendButton: ".send-button button, [data-test-id='send-button-container'] button",
  response: "model-response",
  responseContent: "message-content",
  codeBlock: "code-block",
  /** Code of code blocks only: inline code in a sentence is not a call block (the plain-text search covers it). */
  code: "code[data-test-id='code-content'], pre code",
  query: "user-query",
  queryText: ".query-text",
  queryLine: ".query-text-line",
} as const;

function editor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SEL.editor);
}

/**
 * The text in the input box, one line per paragraph as Quill keeps it. Quill's placeholder is drawn by CSS, so
 * it is not in the text; its "ql-blank" class is not used here, as Quill updates it only a moment after a change.
 */
function editorText(): string {
  const ed = editor();
  if (!ed) return "";
  const blocks = [...ed.children].filter((c) => /^(P|DIV|PRE|H\d|LI)$/.test(c.tagName));
  if (blocks.length) return blocks.map((b) => (b.textContent ?? "").replace(/ /g, " ")).join("\n").trim();
  return ed.innerText.replace(/ /g, " ").trim();
}

function isGenerating(): boolean {
  return document.querySelector(`${SEL.sendWrapper}.stop`) !== null;
}

/** The send button, only while it sends (not while it is the stop button). */
function sendButton(): HTMLButtonElement | null {
  if (isGenerating()) return null;
  const b = document.querySelector<HTMLButtonElement>(SEL.sendButton);
  if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return null;
  return b;
}

/** True when `target` is the send button (or inside it) while it sends. */
function isSendButton(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const wrapper = target.closest(SEL.sendWrapper);
  return wrapper !== null && !wrapper.classList.contains("stop") && target.closest("button") !== null;
}

function isStopButton(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`${SEL.sendWrapper}.stop`) !== null;
}

function isInEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("rich-textarea") !== null;
}

function responses(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SEL.response)];
}

/** Gemini's id of a response (`r_...`), taken from its message element; the position when there is none. */
function responseId(el: HTMLElement, index: number): string {
  const holder = el.querySelector<HTMLElement>(`${SEL.responseContent}[id], [id^='model-response-message-content']`);
  const m = holder?.id.match(/r_[0-9a-f]+/i);
  return m ? m[0] : `${location.pathname}#${index}`;
}

/** The reply as the user reads it (innerText forces a layout: only when it is needed). */
function responseText(el: HTMLElement): string {
  return (el.querySelector<HTMLElement>(SEL.responseContent) ?? el).innerText;
}

/** Cheap: to notice that a reply is still being written. */
function responseRaw(el: HTMLElement): string {
  return el.textContent ?? "";
}

interface Block {
  /** The element after which the extension puts its card. */
  anchor: HTMLElement;
  text: string;
}

function codeBlocks(el: HTMLElement): Block[] {
  const blocks: Block[] = [];
  const seen = new Set<Element>();
  for (const code of el.querySelectorAll<HTMLElement>(SEL.code)) {
    const anchor = code.closest<HTMLElement>(SEL.codeBlock) ?? code.closest<HTMLElement>("pre") ?? code;
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    blocks.push({ anchor, text: code.textContent ?? "" });
  }
  return blocks;
}

function queries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SEL.query)];
}

/** The lines of a message of the user as Gemini shows them, each a paragraph. */
function queryLines(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(SEL.queryLine)];
}

function queryTextBox(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(SEL.queryText);
}

/** The conversation's id from the address (/app/<id>, /gem/<gem>/<id>); null in a new chat. */
function conversationId(path = location.pathname): string | null {
  const m = path.match(/^\/(?:u\/\d+\/)?(?:app|gem\/[^/]+)\/([0-9a-f]{8,})/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------------------
// Writing into the input box. Gemini's box is a Quill editor: text typed through execCommand goes through the
// same path as typing, so Quill's model stays in step with what is shown.

function focusEditor(): HTMLElement | null {
  const ed = editor();
  if (!ed) return null;
  ed.focus();
  return ed;
}

function insertAtStart(text: string): boolean {
  const ed = focusEditor();
  if (!ed) return false;
  caretToStart(ed);
  return document.execCommand("insertText", false, text);
}

function replaceText(text: string): boolean {
  const ed = focusEditor();
  if (!ed) return false;
  selectAllIn(ed);
  return document.execCommand("insertText", false, text);
}

/**
 * Clicks send once the button is ready; true when Gemini started writing or the box emptied.
 * Quill takes text written into the box into its model a moment later (through a MutationObserver), and Gemini
 * sends the model: a click in the same moment would send the box as it was before.
 * A click Gemini did not take (a dialog came up over the page at that moment) is made again after a while: Gemini
 * empties the box at once when it takes one.
 */
/** Counts the stops: a send still trying when the extension was turned off gives up. */
let stops = 0;

async function submit(timeoutMs = 8000): Promise<boolean> {
  await sleep(300);
  const end = Date.now() + timeoutMs;
  const gen = stops;
  let clickedAt = 0;
  let clicks = 0;
  while (Date.now() < end) {
    if (gen !== stops) return false;
    if (clicks && (isGenerating() || editorText() === "")) return true;
    const b = sendButton();
    if (b && (!clicks || (clicks < 3 && Date.now() - clickedAt > RECLICK_MS))) {
      b.click();
      clickedAt = Date.now();
      clicks++;
    }
    await sleep(100);
  }
  return clicks > 0 && (isGenerating() || editorText() === "");
}

const RECLICK_MS = 2500;

// ---------------------------------------------------------------------------------------------------------
// Watching the replies

const STABLE_MS = 1200;
/** A message whose answer has not started in this time is no longer waited for. */
const EXPECT_MAX_MS = 5 * 60_000;

/** The message this tab sent and waits for the answer to. */
interface Expect {
  /** Start and end of the message without whitespace: the answer follows the user message that matches. */
  print: string;
  /** Ids of the replies on the page when the message went out. */
  before: Set<string>;
  at: number;
  given?: string;
}

function fingerprint(text: string): string {
  const s = text.replace(/\s+/g, "");
  return s.length <= 200 ? s : `${s.slice(0, 100)}…${s.slice(-100)}`;
}

function queryText(q: HTMLElement): string {
  return queryLines(q)
    .map((l) => l.textContent ?? "")
    .join("\n");
}

function replyIds(): Set<string> {
  return new Set(responses().map((r, i) => responseId(r, i)));
}

/** The user message right before `reply` on the page (walking back from the last one). */
function queryBefore(reply: HTMLElement): HTMLElement | null {
  const qs = queries();
  for (let i = qs.length - 1; i >= 0; i--) if (qs[i].compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) return qs[i];
  return null;
}

export class GeminiPage implements Page {
  readonly kind = "gemini";
  readonly addressShared = false;
  private expecting: Expect | null = null;
  private prog: Progress | null = null;
  private readonly handled = new Set<string>();
  private latest = { id: "", raw: "", since: 0 };
  /** Cards by reply id and block number, for the conversation on the page. */
  private readonly cards = new Map<string, Card>();
  /** Messages already given their chips, and earlier replies already given their cards: skipped by each tick. */
  private doneQueries = new WeakSet<HTMLElement>();
  private doneReplies = new WeakSet<HTMLElement>();

  editorText = editorText;
  insertAtStart = insertAtStart;
  replaceText = replaceText;
  submit = () => submit();

  isSendKey(e: KeyboardEvent): boolean {
    return isInEditor(e.target) && editorText() !== "";
  }

  isSendClick(e: MouseEvent): boolean {
    return isSendButton(e.target);
  }

  isStopClick(e: MouseEvent): boolean {
    return isStopButton(e.target);
  }

  address(): string {
    return location.pathname;
  }

  chatKey(address = location.pathname): string {
    return conversationId(address) ?? "new";
  }

  sameConversation(from: string): boolean {
    // a new chat got its address (or the user opened another chat: then the answer check fails, nothing runs)
    return this.chatKey(from) === "new" && this.chatKey() !== "new";
  }

  givenKey(): string | null {
    return conversationId();
  }

  instructionsOnPage(): boolean {
    return queries().some((q) => q.textContent?.includes(MARK.instructions));
  }

  expect(text: string, given?: string): void {
    this.expecting = { print: fingerprint(text), before: replyIds(), at: Date.now(), given };
    dbg("expecting", this.expecting.print.slice(0, 60), this.expecting.before.size);
  }

  unexpect(): void {
    this.expecting = null;
    this.prog = null;
  }

  progress(): Progress | null {
    return this.prog;
  }

  inputArea(): Element[] {
    return [editor(), document.querySelector(SEL.sendButton)].filter((e): e is Element => !!e);
  }

  tick(active: boolean, busy: boolean): Finished | null {
    const generating = isGenerating();
    // Gemini writes, but not for a message this tab sent (a suggestion chip, "regenerate"): the answer is the
    // reply that comes after the replies there are now, to the user message that is last now
    if (generating && !this.expecting && active) {
      const last = queries().at(-1);
      if (last) this.expecting = { print: fingerprint(queryText(last)), before: replyIds(), at: Date.now() };
    }
    // a reply that is being written is still awaited, however long it takes
    if (this.expecting && !generating && Date.now() - this.expecting.at > EXPECT_MAX_MS) {
      problem(`No reply to the message was found within ${EXPECT_MAX_MS / 60_000} minutes: the bridge stopped waiting for it. Gemini's page may have changed (the status menu has "Copy page structure").`);
      this.expecting = null;
    }
    const list = responses();
    const awaited = this.awaitedReply(list);
    this.decorate(list, awaited?.id, generating);
    this.prog = this.expecting
      ? { writing: generating, replySeen: !!awaited, calls: awaited ? codeBlocks(awaited.reply).filter((b) => looksLikeCall(b.text)).length : 0, how: "known" }
      : null;
    if (busy || generating || !awaited) return null;
    const raw = responseRaw(awaited.reply);
    if (this.latest.id !== awaited.id || this.latest.raw !== raw) {
      this.latest = { id: awaited.id, raw, since: Date.now() };
      return null;
    }
    if (Date.now() - this.latest.since < STABLE_MS) return null;
    const { reply, id } = awaited;
    this.handled.add(id);
    const given = this.expecting?.given;
    this.expecting = null;
    this.prog = null;
    dbg("reply finished", id);
    return { items: () => this.itemsOf(reply, id), present: () => replyIds().has(id), given };
  }

  otherConversation(): void {
    this.expecting = null;
    this.prog = null;
    for (const c of this.cards.values()) c.drop();
    this.cards.clear();
    this.handled.clear();
    this.doneQueries = new WeakSet();
    this.doneReplies = new WeakSet();
  }

  stop(): void {
    stops++;
    this.otherConversation();
    for (const c of document.querySelectorAll(".gmb-chip")) c.remove();
    for (const l of document.querySelectorAll(".gmb-hidden-line")) l.classList.remove("gmb-hidden-line");
  }

  /** The last reply, when it is the answer to the expected message. */
  private awaitedReply(list: HTMLElement[]): { reply: HTMLElement; id: string } | null {
    const e = this.expecting;
    if (!e) return null;
    const reply = list.at(-1);
    if (!reply) return null;
    const id = responseId(reply, list.length - 1);
    if (this.handled.has(id) || e.before.has(id)) return null;
    const q = queryBefore(reply);
    if (!q || fingerprint(queryText(q)) !== e.print) return null;
    return { reply, id };
  }

  private cardFor(key: string, anchor: HTMLElement): Card {
    let card = this.cards.get(key);
    if (!card) {
      card = new Card();
      this.cards.set(key, card);
    }
    if (card.host.previousElementSibling !== anchor) anchor.after(card.host);
    return card;
  }

  /** Cards under the call blocks, chips over the instruction and result messages: each done once. */
  private decorate(list: HTMLElement[], awaitedId: string | undefined, generating: boolean): void {
    const e = this.expecting;
    list.forEach((resp, i) => {
      const isLast = i === list.length - 1;
      if (this.doneReplies.has(resp)) return;
      const id = responseId(resp, i);
      const live = id === awaitedId || (generating && isLast && !this.handled.has(id) && !!e && !e.before.has(id));
      let complete = true;
      codeBlocks(resp)
        .filter((b) => looksLikeCall(b.text))
        .forEach((b, j) => {
          const card = this.cardFor(`${id}#${j}`, b.anchor);
          if (card.mode === "live") return;
          const mode = live ? "waiting" : "earlier";
          if (card.mode !== mode || card.text !== b.text) {
            const parsed = parseCalls([b.text]);
            card.setCalls(parsed.calls, parsed.problems, mode);
            card.mode = mode;
            card.text = b.text;
          }
          if (!card.host.isConnected) complete = false;
        });
      // the last reply may still change; earlier ones are done once their cards are placed
      if (!isLast && complete) this.doneReplies.add(resp);
    });
    for (const q of queries()) {
      const box = queryTextBox(q);
      if (!box || this.doneQueries.has(box)) continue;
      const lines = queryLines(q);
      if (!lines.length) continue;
      this.doneQueries.add(box);
      const texts = lines.map((l) => (l.textContent ?? "").trim());
      if (texts[0]?.startsWith(MARK.results)) {
        // results, perhaps followed by the user's own text
        const endR = resultsEnd(texts, 0);
        collapse(lines.slice(0, endR), t("chipResults", { s: summarizeResults(texts.slice(0, endR).join("\n")) }));
        continue;
      }
      const start = texts.findIndex((x) => x.startsWith(MARK.instructions) || x.startsWith(MARK.toolsUpdate));
      if (start < 0) continue;
      const end = texts.indexOf(MARK.instructionsEnd, start);
      const block = texts.slice(start, end < 0 ? undefined : end);
      const heading = block.findIndex((x) => x.startsWith(TOOLS_HEADING));
      const count = heading < 0 ? 0 : block.slice(heading + 1).filter((x) => /^- \S+: /.test(x)).length;
      collapse(lines.slice(start, end < 0 ? undefined : end + 1), texts[start].startsWith(MARK.instructions) ? t("chipInstructions", { n: count }) : t("chipUpdate"));
      // results that waited for the user's message come after the instructions in the same message
      const r = texts.findIndex((x, k) => k > (end < 0 ? start : end) && x.startsWith(MARK.results));
      if (r >= 0) {
        const endR = resultsEnd(texts, r);
        collapse(lines.slice(r, endR), t("chipResults", { s: summarizeResults(texts.slice(r, endR).join("\n")) }), "results");
      }
    }
  }

  /** The calls of a reply, each block with its card, already live (no tick turns them into "earlier"). */
  private itemsOf(resp: HTMLElement, id: string): Item[] {
    const items: Item[] = [];
    let j = 0;
    for (const b of codeBlocks(resp)) {
      if (!looksLikeCall(b.text)) continue;
      items.push({ card: this.cardFor(`${id}#${j++}`, b.anchor), ...parseCalls([b.text]) });
    }
    if (!items.length) {
      // Gemini dropped the code fence: the card goes at the end of the reply
      const text = responseText(resp);
      const parsed = parseCalls([], text);
      if (parsed.calls.length || parsed.problems.length) items.push({ card: this.cardFor(`${id}#text`, resp.querySelector<HTMLElement>(SEL.responseContent) ?? resp), ...parsed });
      // prose may name the key too, so nothing goes back to Gemini for it
      else if (looksLikeCall(text)) problem("The reply names mcp_call outside a code block, and no call could be read from it.", text.slice(0, 2000));
    }
    const found = items.filter((it) => it.calls.length || it.problems.length);
    for (const it of found) it.card.mode = "live";
    return found;
  }
}
