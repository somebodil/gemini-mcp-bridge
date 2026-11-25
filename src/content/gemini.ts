// Everything the extension knows about the page of gemini.google.com. When Gemini changes its page, this is
// the file to change. Selectors avoid text (the page is in the user's language) and prefer Gemini's own
// element names and test ids.

export const SEL = {
  editor: "rich-textarea .ql-editor[contenteditable='true'], rich-textarea [contenteditable='true']",
  /** The send button's wrapper carries `submit` when it sends and `stop` while Gemini writes. */
  sendWrapper: ".send-button",
  sendButton: ".send-button button, [data-test-id='send-button-container'] button",
  response: "model-response",
  responseContent: "message-content",
  codeBlock: "code-block",
  code: "code[data-test-id='code-content'], pre code, code",
  query: "user-query",
  queryText: ".query-text",
  queryLine: ".query-text-line",
} as const;

export function editor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SEL.editor);
}

/**
 * The text in the input box, one line per paragraph as Quill keeps it. Quill's placeholder is drawn by CSS, so
 * it is not in the text; its "ql-blank" class is not used here, as Quill updates it only a moment after a change.
 */
export function editorText(): string {
  const ed = editor();
  if (!ed) return "";
  const blocks = [...ed.children].filter((c) => /^(P|DIV|PRE|H\d|LI)$/.test(c.tagName));
  if (blocks.length) return blocks.map((b) => (b.textContent ?? "").replace(/ /g, " ")).join("\n").trim();
  return ed.innerText.replace(/ /g, " ").trim();
}

export function isGenerating(): boolean {
  return document.querySelector(`${SEL.sendWrapper}.stop`) !== null;
}

/** The send button, only while it sends (not while it is the stop button). */
export function sendButton(): HTMLButtonElement | null {
  if (isGenerating()) return null;
  const b = document.querySelector<HTMLButtonElement>(SEL.sendButton);
  if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return null;
  return b;
}

/** True when `target` is the send button (or inside it) while it sends. */
export function isSendButton(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const wrapper = target.closest(SEL.sendWrapper);
  return wrapper !== null && !wrapper.classList.contains("stop") && target.closest("button") !== null;
}

export function isStopButton(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`${SEL.sendWrapper}.stop`) !== null;
}

export function isInEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("rich-textarea") !== null;
}

export function responses(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SEL.response)];
}

/** Gemini's id of a response (`r_...`), taken from its message element; the position when there is none. */
export function responseId(el: HTMLElement, index: number): string {
  const holder = el.querySelector<HTMLElement>(`${SEL.responseContent}[id], [id^='model-response-message-content']`);
  const m = holder?.id.match(/r_[0-9a-f]+/i);
  return m ? m[0] : `${location.pathname}#${index}`;
}

export function responseText(el: HTMLElement): string {
  return (el.querySelector<HTMLElement>(SEL.responseContent) ?? el).innerText;
}

export interface Block {
  /** The element after which the extension puts its card. */
  anchor: HTMLElement;
  text: string;
}

export function codeBlocks(el: HTMLElement): Block[] {
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

export function queries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SEL.query)];
}

/** The lines of a message of the user as Gemini shows them, each a paragraph. */
export function queryLines(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(SEL.queryLine)];
}

export function queryTextBox(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(SEL.queryText);
}

/** The conversation's id from the address (/app/<id>, /gem/<gem>/<id>); null in a new chat. */
export function conversationId(path = location.pathname): string | null {
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

export function insertAtStart(text: string): boolean {
  const ed = focusEditor();
  if (!ed) return false;
  const range = document.createRange();
  range.setStart(ed.firstChild ?? ed, 0);
  range.collapse(true);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return document.execCommand("insertText", false, text);
}

export function replaceText(text: string): boolean {
  const ed = focusEditor();
  if (!ed) return false;
  const range = document.createRange();
  range.selectNodeContents(ed);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return document.execCommand("insertText", false, text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Clicks send once the button is ready; true when Gemini started writing or the box emptied.
 * Quill takes text written into the box into its model a moment later (through a MutationObserver), and Gemini
 * sends the model: a click in the same moment would send the box as it was before.
 */
export async function submit(timeoutMs = 8000): Promise<boolean> {
  await sleep(300);
  const end = Date.now() + timeoutMs;
  let clicked = false;
  while (Date.now() < end) {
    if (clicked && (isGenerating() || editorText() === "")) return true;
    const b = sendButton();
    if (b && !clicked) {
      b.click();
      clicked = true;
    }
    await sleep(100);
  }
  return clicked && (isGenerating() || editorText() === "");
}
