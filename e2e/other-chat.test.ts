// Learning and then using a second chat page built unlike the first (mock-chat2.html): no shadow roots, a
// contenteditable box, the whole page scrolls, my messages and replies told apart only by a data attribute, a send
// button greyed while the box is empty or a reply is written, and no stop button: nothing tells that the page is
// writing, so the end of a reply is told by its text standing still.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import type { Layout } from "../src/content/layout.ts";
import { MARK } from "../src/shared/protocol.ts";
import { auto, startHarness, type Harness } from "./harness.ts";
import { box, button, closeResults, startLearning } from "./learning.ts";

const MOCK = readFileSync(join(import.meta.dirname, "mock-chat2.html"), "utf8");
const SITE = "https://chat2.example.test";
const call = (tool: string, args: Record<string, unknown>) => `Let me check.\n\n\`\`\`json\n${JSON.stringify({ mcp_call: { tool, arguments: args } })}\n\`\`\``;

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

type MockWindow = { __sent: string[] };

interface Chat {
  page: Page;
  logs: string[];
}

async function open(replies: string[] = []): Promise<Chat> {
  const page = await h.context.newPage();
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().startsWith("[gmb]")) logs.push(msg.text());
  });
  await page.addInitScript((r) => {
    localStorage.setItem("gmb-debug", "1");
    Object.assign(window, { __replies: r, __stepMs: 300 });
  }, replies);
  await page.goto(`${SITE}/`);
  assert.equal(await h.toggle(page), true);
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return { page, logs };
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__sent);
const waitSent = (page: Page, n: number) => page.waitForFunction((k) => (window as unknown as MockWindow).__sent.length >= k, n, { timeout: 25_000 });
const found = (page: Page, role: string) => page.locator(`gmb-status .roles li[data-role="${role}"]`).getAttribute("data-found");

async function stored(): Promise<Layout | undefined> {
  const all = await h.worker.evaluate(async () => (await chrome.storage.local.get("layouts")).layouts as Record<string, Layout> | undefined);
  return all?.[SITE];
}

async function waitLog(c: Chat, pattern: RegExp, timeout = 25_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!c.logs.some((l) => pattern.test(l))) {
    if (Date.now() > end) throw new Error(`no log ${pattern}; got:\n${c.logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The learning box (or another of the extension's boxes) covers neither the input box nor the send button. */
async function clearOfComposer(page: Page, ours = box(page)): Promise<void> {
  const a = await ours.boundingBox();
  assert.ok(a);
  for (const sel of [".composer .editor", ".composer .send"]) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b);
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `box ${JSON.stringify(a)} covers ${sel} ${JSON.stringify(b)}`);
  }
}

/** Learns the page, the test message sent with Enter, up to the list of what was learned. */
async function learn(page: Page): Promise<void> {
  await startLearning(page);
  await clearOfComposer(page);
  await page.locator(".editor").click();
  await page.waitForFunction(() => document.querySelector<HTMLElement>(".editor")?.innerText.includes("gmb_test"));
  await page.locator(".editor").press("Enter");
  await box(page).filter({ hasText: "Everything seen" }).waitFor({ timeout: 25_000 });
  // nothing showed that the page was writing: that step is passed over, with why
  const busyStep = page.locator('gmb-status .learn li[data-step="busy"]');
  assert.equal(await busyStep.getAttribute("class"), "skip", (await busyStep.textContent()) ?? "");
  await clearOfComposer(page);
  await button(page, "Stop learning").click();
  await box(page).filter({ hasText: "What the extension learned" }).waitFor();
  await clearOfComposer(page);
}

/** What each pattern matches on the page, as tag.classes[author]. */
function kinds(page: Page, l: Layout): Promise<Record<"mine" | "reply" | "code", string[]>> {
  return page.evaluate((l) => {
    const name = (e: Element) => [e.localName, ...e.classList].join(".") + (e.getAttribute("data-message-author-role") ? `[${e.getAttribute("data-message-author-role")}]` : "");
    const of = (sel?: string) => (sel ? [...document.querySelectorAll("*")].filter((e) => e.matches(sel)).map(name) : []);
    return { mine: of(l.mine), reply: of(l.reply), code: of(l.code) };
  }, l);
}

describe("a chat page built otherwise", () => {
  it("is learned from one test message sent with Enter; the greyed send button is not taken for a writing indicator", async () => {
    const { page } = await open();
    try {
      await learn(page);
      assert.equal(await found(page, "input"), "ok");
      assert.equal(await found(page, "send"), "unsure");
      assert.equal(await found(page, "busy"), "missing");
      assert.equal(await found(page, "mine"), "ok");
      assert.equal(await found(page, "reply"), "ok");
      assert.equal(await found(page, "code"), "ok");
      const l = await stored();
      assert.ok(l);
      assert.equal(l.busy, undefined, JSON.stringify(l.busy));
      assert.deepEqual(
        await page.evaluate((loc) => [loc.input, loc.send].map((x) => (x ? document.querySelector(x.join(" "))?.className : null)), { input: l.input, send: l.send }),
        ["editor", "send"],
      );
      // told apart by the data attribute alone
      assert.deepEqual(await kinds(page, l), { mine: ["article.turn[user]"], reply: ["article.turn[assistant]"], code: ["pre"] });
    } finally {
      await page.close();
    }
  });

  it("once learned, a call goes round: the instructions go with the message, the results with the send button, the end told by the text standing still", async () => {
    await h.setSettings(auto("list_directory"));
    const c = await open([call("list_directory", { path: h.dir }), "There is a-file.txt."]);
    try {
      await learn(c.page);
      await closeResults(c.page);
      // the box one types in a little higher: the status line would open over its send button
      await c.page.addStyleTag({ content: ".composer { bottom: 40px; }" });
      await c.page.locator(".editor").click();
      await c.page.keyboard.type("What is in my folder?");
      await c.page.keyboard.press("Enter");
      const flow = c.page.locator("gmb-status .flow");
      await flow.waitFor({ timeout: 10_000 });
      await clearOfComposer(c.page, flow);
      await waitSent(c.page, 2);
      const first = (await sent(c.page))[1];
      assert.ok(first.startsWith(MARK.instructions) && first.endsWith("What is in my folder?"), first.slice(0, 80));
      await waitSent(c.page, 3);
      assert.match((await sent(c.page))[2], /^\[MCP Bridge · results\]\n#1 list_directory → ok/);
      await waitLog(c, /answer without calls/);
      assert.deepEqual(h.calls, ["list_directory"]);
      assert.ok(c.logs.some((l) => /reply finished 1 learned/.test(l)), c.logs.join("\n"));
      await c.page.locator("gmb-status .flow").filter({ hasText: "Done: the reply has no call" }).waitFor({ timeout: 15_000 });
      assert.equal((await sent(c.page)).length, 3);
    } finally {
      await c.page.close();
    }
  });
});
