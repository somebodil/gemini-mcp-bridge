// Chat pages made to trip the extension up (mock-hostile.html, one option per behavior): line numbers and copy
// buttons inside code blocks, hidden copies of replies, Ctrl+Enter senders, nameless icon buttons, a "Send feedback"
// button by the box, input boxes that keep their own text or are made anew, pauses in a reply, no writing
// indicator, turns drawn anew all the time, virtual lists, a closed shadow root. Each page is learned first, as the
// user would on a page the extension does not know, then a call has to go round.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ElementHandle, Page } from "playwright";
import type { Layout } from "../src/content/layout.ts";
import { MARK } from "../src/shared/protocol.ts";
import { auto, startHarness, type Harness } from "./harness.ts";
import { box, button, closeResults, startLearning } from "./learning.ts";

const MOCK = readFileSync(join(import.meta.dirname, "mock-hostile.html"), "utf8");
const SITE = "https://hostile.example.test";
/** A call as models often write it: pretty-printed over several lines. */
const call = (tool: string, args: Record<string, unknown>) => `Let me check.\n\n\`\`\`json\n${JSON.stringify({ mcp_call: { tool, arguments: args } }, null, 2)}\n\`\`\``;

let h: Harness;

before(async () => {
  h = await startHarness();
  await h.context.route(`${SITE}/**`, (route) => route.fulfill({ contentType: "text/html", body: MOCK }));
  writeFileSync(join(h.dir, "a-file.txt"), "content of a file\n");
});
after(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.setSettings({});
  await h.worker.evaluate(() => chrome.storage.local.remove(["given", "layouts"]));
  h.calls.length = 0;
});

interface Opts {
  lineNumbers?: boolean;
  srCopy?: boolean;
  virtual?: number;
  pauseMs?: number;
  rawThenRender?: boolean;
  ctrlEnter?: boolean;
  ownEditor?: boolean;
  textarea?: boolean;
  newInput?: boolean;
  feedback?: boolean;
  iconButton?: boolean;
  noStop?: boolean;
  redraw?: number;
  closedShadow?: boolean;
  sidebar?: boolean;
  mentions?: boolean;
  canvas?: boolean;
  lateMine?: number;
  swapLate?: number;
  deepEditor?: number;
}

type MockWindow = { __sent: string[]; __feedback: number; __sidebar: number; __root: ShadowRoot | HTMLElement; __switch: () => void };

interface Chat {
  page: Page;
  logs: string[];
}

async function open(opts: Opts, replies: string[] = []): Promise<Chat> {
  const page = await h.context.newPage();
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().startsWith("[gmb]")) logs.push(msg.text());
  });
  await page.addInitScript(
    ([o, r]) => {
      localStorage.setItem("gmb-debug", "1");
      Object.assign(window, { __opts: o, __replies: r, __stepMs: 200 });
    },
    [opts, replies] as const,
  );
  await page.goto(`${SITE}/`);
  assert.equal(await h.toggle(page), true);
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return { page, logs };
}

/** An element of the mock, also inside its closed shadow root. */
async function el(page: Page, sel: string): Promise<ElementHandle<Element>> {
  const handle = await page.evaluateHandle((s) => (window as unknown as MockWindow).__root.querySelector(s), sel);
  const e = handle.asElement();
  assert.ok(e, sel);
  return e;
}

const editorText = (page: Page) =>
  page.evaluate(() => {
    const ed = (window as unknown as MockWindow).__root.querySelector(".editor") as HTMLElement | HTMLTextAreaElement;
    return ed instanceof HTMLTextAreaElement ? ed.value : ed.innerText;
  });
const sent = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__sent);
const waitSent = (page: Page, n: number, timeout = 25_000) =>
  page.waitForFunction((k) => (window as unknown as MockWindow).__sent.length >= k, n, { timeout });

async function stored(): Promise<Layout | undefined> {
  const all = await h.worker.evaluate(async () => (await chrome.storage.local.get("layouts")).layouts as Record<string, Layout> | undefined);
  return all?.[SITE];
}

async function waitLog(c: Chat, pattern: RegExp, timeout = 30_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!c.logs.some((l) => pattern.test(l))) {
    if (Date.now() > end) throw new Error(`no log ${pattern}; got:\n${c.logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type How = "click" | "Enter" | "Control+Enter";

async function press(page: Page, how: How): Promise<void> {
  if (how === "click") await (await el(page, ".send")).click();
  else await page.keyboard.press(how);
}

/** Learns the page: the test message goes in where the user clicks, and out the way `how` says. */
async function learn(page: Page, how: How): Promise<void> {
  await startLearning(page);
  await (await el(page, ".editor")).click();
  await page.waitForFunction(() => {
    const ed = (window as unknown as MockWindow).__root.querySelector<HTMLElement | HTMLTextAreaElement>(".editor");
    return (ed instanceof HTMLTextAreaElement ? ed.value : ed?.innerText)?.includes("gmb_test");
  });
  await press(page, how);
  await box(page).filter({ hasText: "Everything seen" }).waitFor({ timeout: 30_000 });
  await button(page, "Stop learning").click();
  await box(page).filter({ hasText: "What the extension learned" }).waitFor();
}

/** Types into the mock's input box as the user does. */
async function type(page: Page, text: string): Promise<void> {
  await (await el(page, ".editor")).click();
  await page.keyboard.type(text);
}

/** A question whose answer needs list_directory (allowed to run by itself), then the answer: one round. */
async function roundTrip(c: Chat, how: How, opts: { first?: number; answerWithin?: number } = {}): Promise<void> {
  const first = opts.first ?? 1;
  await type(c.page, "What is in my folder?");
  await press(c.page, how);
  await waitSent(c.page, first + 1);
  const q = (await sent(c.page))[first];
  assert.ok(q.startsWith(MARK.instructions), `the instructions go with it: ${q.slice(0, 80)}`);
  assert.ok(q.endsWith("What is in my folder?"), `the question once, at the end: ${q.slice(-80)}`);
  assert.equal(q.split("What is in my folder?").length - 1, 1, "the question once");
  await waitSent(c.page, first + 2, 40_000);
  assert.match((await sent(c.page))[first + 1], /^\[MCP Bridge · results\]\n#1 list_directory → ok/);
  await waitLog(c, /answer without calls/, opts.answerWithin ?? 40_000);
  assert.deepEqual(h.calls, ["list_directory"]);
}

const replies = () => [call("list_directory", { path: h.dir }), "There is a-file.txt."];

describe("hostile chat pages, learned", () => {
  it("code blocks with line numbers and a Copy button inside, and a hidden copy of each reply", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ lineNumbers: true, srCopy: true }, replies());
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await roundTrip(c, "click");
    } finally {
      await c.page.close();
    }
  });

  it("an input box deep inside its composer (as on Gemini), learned with Enter: the send button and the stop button are found", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ deepEditor: 8 }, replies());
    try {
      await learn(c.page, "Enter");
      const l = await stored();
      assert.ok(l?.send, "the send button, by its name");
      assert.ok(l?.busy, "the stop button, as the sign of writing");
      await closeResults(c.page);
      await roundTrip(c, "Enter");
    } finally {
      await c.page.close();
    }
  });

  it("Ctrl+Enter sends and Enter makes a new line; the send button is a nameless icon; a Send feedback button by the box", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ ctrlEnter: true, iconButton: true, feedback: true }, replies());
    try {
      await learn(c.page, "Control+Enter");
      await closeResults(c.page);
      assert.equal((await stored())?.sendKey, "mod");
      // Enter: a new line in the box, nothing goes out
      await type(c.page, "line one");
      await c.page.keyboard.press("Enter");
      await c.page.waitForTimeout(1500);
      assert.equal((await sent(c.page)).length, 1);
      assert.match(await editorText(c.page), /line one\n/);
      await c.page.keyboard.press("Control+A");
      await c.page.keyboard.press("Backspace");
      await roundTrip(c, "Control+Enter");
      assert.equal(await c.page.evaluate(() => (window as unknown as MockWindow).__feedback), 0, "the feedback button was not pressed");
    } finally {
      await c.page.close();
    }
  });

  it("an input box that keeps its own text (takes it only through beforeinput and paste), made anew after each send", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ ownEditor: true, newInput: true }, replies());
    try {
      await learn(c.page, "Enter");
      await closeResults(c.page);
      await roundTrip(c, "Enter");
    } finally {
      await c.page.close();
    }
  });

  it("a pause before the code block, and raw markdown while the reply is written", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ pauseMs: 8000, rawThenRender: true }, replies());
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await roundTrip(c, "click");
    } finally {
      await c.page.close();
    }
  });

  it("nothing shows that the page writes, and the reply stops longer than it takes to look finished", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ noStop: true, pauseMs: 9000 }, replies());
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await roundTrip(c, "click");
    } finally {
      await c.page.close();
    }
  });

  it("every turn drawn anew every 400 ms while a call waits for Run: one card, one run", async () => {
    const c = await open({ redraw: 400, lineNumbers: true }, replies());
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await type(c.page, "What is in my folder?");
      await press(c.page, "click");
      const run = c.page.locator("gmb-card").getByRole("button", { name: "Run", exact: true });
      await run.waitFor({ timeout: 20_000 });
      await c.page.waitForTimeout(2500);
      assert.equal(await c.page.locator("gmb-card").count(), 1);
      await run.click();
      await waitSent(c.page, 3);
      await waitLog(c, /answer without calls/, 40_000);
      assert.deepEqual(h.calls, ["list_directory"]);
      assert.equal((await sent(c.page)).filter((s) => s.startsWith("[MCP Bridge · results]")).length, 1);
    } finally {
      await c.page.close();
    }
  });

  it("the code block drawn otherwise while its call waits for Run (other text): the card with Run goes with it", async () => {
    const c = await open({ swapLate: 4000 }, replies());
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await type(c.page, "What is in my folder?");
      await press(c.page, "click");
      const run = c.page.locator("gmb-card").getByRole("button", { name: "Run", exact: true });
      await run.waitFor({ timeout: 20_000 });
      // the block is drawn anew with a heading and line numbers (the test message's reply was, before)
      await c.page.waitForFunction(() => (window as unknown as MockWindow).__root.querySelectorAll(".cb").length >= 2, null, { timeout: 10_000 });
      await c.page.waitForTimeout(1000);
      await run.click({ timeout: 5000 });
      await waitSent(c.page, 3);
      await waitLog(c, /answer without calls/, 40_000);
      assert.deepEqual(h.calls, ["list_directory"]);
    } finally {
      await c.page.close();
    }
  });

  it("a virtual list that keeps only the last 4 turns: the instructions go once per conversation", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ virtual: 4 }, [...replies(), "Hello again.", "And again."]);
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await roundTrip(c, "click");
      for (const [i, q] of ["Thanks.", "One more thing."].entries()) {
        await type(c.page, q);
        await press(c.page, "click");
        await waitSent(c.page, 4 + i);
        await waitLog(c, new RegExp(`reply finished.*`), 20_000);
        await c.page.waitForTimeout(1500);
      }
      const s = await sent(c.page);
      assert.equal(s.filter((m) => m.startsWith(MARK.instructions)).length, 1, s.map((m) => m.slice(0, 40)).join(" | "));
    } finally {
      await c.page.close();
    }
  });

  it("the same short message twice, drawn only once the server answered: the first one's call does not run again", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ lateMine: 3500 }, [call("list_directory", { path: h.dir }), "Done.", "Sure."]);
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await type(c.page, "yes");
      await press(c.page, "click");
      await waitSent(c.page, 3, 30_000);
      await waitLog(c, /answer without calls/, 40_000);
      c.logs.length = 0;
      await type(c.page, "yes");
      await press(c.page, "click");
      await waitSent(c.page, 4);
      await waitLog(c, /answer without calls/, 40_000);
      await c.page.waitForTimeout(1500);
      assert.deepEqual(h.calls, ["list_directory"], "one run, for the first answer");
      assert.equal((await sent(c.page)).length, 4, "no results sent for the old call");
    } finally {
      await c.page.close();
    }
  });

  it("a big document one writes in beside the chat: Enter there is not a send", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ canvas: true }, replies());
    try {
      await learn(c.page, "Enter");
      await closeResults(c.page);
      await c.page.click(".canvas");
      await c.page.keyboard.press("End");
      await c.page.keyboard.type(" and more");
      await c.page.keyboard.press("Enter");
      await c.page.waitForTimeout(1500);
      assert.equal((await sent(c.page)).length, 1);
      assert.ok(!(await c.page.locator(".canvas").innerText()).includes(MARK.instructions), "nothing written into the document");
      await roundTrip(c, "Enter");
    } finally {
      await c.page.close();
    }
  });

  it("everything in a closed shadow root", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ closedShadow: true, lineNumbers: true, feedback: true, textarea: true }, replies());
    try {
      await learn(c.page, "click");
      await closeResults(c.page);
      await roundTrip(c, "click");
      assert.equal(await c.page.evaluate(() => (window as unknown as MockWindow).__feedback), 0);
    } finally {
      await c.page.close();
    }
  });
});

describe("hostile chat pages, not learned", () => {
  it("a Send feedback button by the box is not taken for the send button", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ feedback: true }, replies());
    try {
      await roundTrip(c, "Enter", { first: 0 });
      assert.equal(await c.page.evaluate(() => (window as unknown as MockWindow).__feedback), 0);
    } finally {
      await c.page.close();
    }
  });

  it("line numbers in code blocks are not read as part of the call", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ lineNumbers: true, textarea: true }, replies());
    try {
      await roundTrip(c, "Enter", { first: 0 });
    } finally {
      await c.page.close();
    }
  });

  it("a list of chats beside the box named Stop and Send: not taken for the page writing, nothing in it pressed", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ sidebar: true }, replies());
    try {
      // "How to stop nginx" taken for a stop button would hold the answer for 20 s
      await roundTrip(c, "Enter", { first: 0, answerWithin: 12_000 });
      assert.equal(await c.page.evaluate(() => (window as unknown as MockWindow).__sidebar), 0);
    } finally {
      await c.page.close();
    }
  });

  it("a nameless icon button and nothing that shows the page writing: an answer without a call ends once the page stands still", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ iconButton: true, sidebar: true }, replies());
    try {
      await roundTrip(c, "Enter", { first: 0 });
      assert.equal(await c.page.evaluate(() => (window as unknown as MockWindow).__sidebar), 0);
    } finally {
      await c.page.close();
    }
  });

  it("Enter that picks from a list the box opened (a mention) is the page's", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ mentions: true }, replies());
    try {
      await type(c.page, "Ask @");
      await c.page.keyboard.press("Enter");
      await c.page.waitForTimeout(1000);
      assert.equal((await sent(c.page)).length, 0, "nothing went out");
      const text = await editorText(c.page);
      assert.match(text, /Ask @alice/);
      assert.ok(!text.includes(MARK.instructions), "nothing put in front");
    } finally {
      await c.page.close();
    }
  });

  it("another chat opened while the answer is written, drawn after the address changed: its old call does not run", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open({ pauseMs: 6000 }, replies());
    try {
      await type(c.page, "What is in my folder?");
      await press(c.page, "Enter");
      await waitSent(c.page, 1);
      await c.page.waitForTimeout(800);
      await c.page.evaluate(() => (window as unknown as MockWindow).__switch());
      await c.page.waitForTimeout(7000);
      assert.deepEqual(h.calls, [], "nothing ran");
      assert.equal((await sent(c.page)).length, 1, "nothing sent into the other chat");
    } finally {
      await c.page.close();
    }
  });
});
