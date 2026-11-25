// Generic mode once the page was learned, against the mock chat page: the learned send button, writing indicator
// and kind of reply are used (so a page whose buttons no guess can read works), the status line follows each
// exchange, and a page that changed since it was learned is said to be so, with what can be done.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import type { Layout } from "../src/content/layout.ts";
import { MARK } from "../src/shared/protocol.ts";
import { auto, startHarness, type Harness } from "./harness.ts";
import { box, closeResults, learn } from "./learning.ts";

const MOCK = readFileSync(join(import.meta.dirname, "mock-chat.html"), "utf8");
const SITE = "https://chat.example.test";
const call = (tool: string, args: Record<string, unknown>) => `Let me check.\n\`\`\`json\n${JSON.stringify({ mcp_call: { tool, arguments: args } })}\n\`\`\``;

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

type MockWindow = { __sent: string[]; __replyClass?: string; __flows: string[] };

interface Chat {
  page: Page;
  logs: string[];
}

async function open(opts: { replies?: string[]; unnamed?: boolean } = {}): Promise<Chat> {
  const page = await h.context.newPage();
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().startsWith("[gmb]")) logs.push(msg.text());
  });
  await page.addInitScript(
    ([replies, unnamed]) => {
      localStorage.setItem("gmb-debug", "1");
      Object.assign(window, { __replies: replies, __stepMs: 300, __unnamed: unnamed, __flows: [] });
      // every state of the status line, in order: its text, then its notes
      const flows = (window as unknown as { __flows: string[] }).__flows;
      const note = (root: ShadowRoot) => {
        const box = root.querySelector(".flow");
        const text = box ? [...box.querySelectorAll(".text, .note")].map((e) => e.textContent).join(" | ") : "";
        if (text && flows.at(-1) !== text) flows.push(text);
      };
      const watch = setInterval(() => {
        const root = document.querySelector("gmb-status")?.shadowRoot;
        if (!root) return;
        clearInterval(watch);
        new MutationObserver(() => note(root)).observe(root, { childList: true, subtree: true, characterData: true });
      }, 20);
    },
    [opts.replies ?? [], opts.unnamed ?? false] as const,
  );
  await page.goto(`${SITE}/`);
  assert.equal(await h.toggle(page), true);
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return { page, logs };
}

async function type(page: Page, text: string): Promise<void> {
  await page.locator("chat-app textarea").click();
  await page.keyboard.type(text);
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__sent);
const waitSent = (page: Page, n: number) => page.waitForFunction((k) => (window as unknown as MockWindow).__sent.length >= k, n, { timeout: 20_000 });
const flows = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__flows);
const flowBox = (page: Page) => page.locator("gmb-status .flow");

async function waitLog(c: Chat, pattern: RegExp, timeout = 20_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!c.logs.some((l) => pattern.test(l))) {
    if (Date.now() > end) throw new Error(`no log ${pattern}; got:\n${c.logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** `want` appear in `got` in this order (others may come between). */
function inOrder(got: string[], want: (string | RegExp)[]): void {
  let i = 0;
  for (const g of got) if (i < want.length && (typeof want[i] === "string" ? g === want[i] : (want[i] as RegExp).test(g))) i++;
  assert.equal(i, want.length, `expected in order: ${want.join(" | ")}\ngot: ${got.join(" | ")}`);
}

describe("generic mode, learned", () => {
  it("a page whose buttons no guess can read: before learning, a click on send carries no instructions", async () => {
    const c = await open({ unnamed: true, replies: ["Hello."] });
    try {
      await type(c.page, "hello");
      await c.page.locator("chat-app icon-button").click();
      await waitSent(c.page, 1);
      assert.equal((await sent(c.page))[0], "hello");
    } finally {
      await c.page.close();
    }
  });

  it("after learning, that send button carries the instructions, the call runs, and the status line follows", async () => {
    const c = await open({ unnamed: true, replies: [call("list_directory", { path: h.dir }), "There is a-file.txt."] });
    try {
      await learn(c.page);
      await closeResults(c.page);
      await type(c.page, "What is in my folder?");
      await c.page.locator("chat-app icon-button").click();
      await waitSent(c.page, 2);
      const first = (await sent(c.page))[1];
      assert.ok(first.startsWith(MARK.instructions) && first.endsWith("What is in my folder?"), first.slice(0, 80));
      await c.page.locator("gmb-card").last().getByRole("button", { name: "Run", exact: true }).click({ timeout: 15_000 });
      // the results went with the learned send button, as the page has no other way it could be guessed
      await waitSent(c.page, 3);
      assert.match((await sent(c.page))[2], /^\[MCP Bridge · results\]\n#1 list_directory → ok/);
      await waitLog(c, /answer without calls/);
      assert.deepEqual(h.calls, ["list_directory"]);
      assert.ok(c.logs.some((l) => /reply finished 1 learned/.test(l)), c.logs.join("\n"));
      await flowBox(c.page).filter({ hasText: "Done: the reply has no call" }).waitFor();
      inOrder(await flows(c.page), [
        "The page is writing the reply | Sent with the tool instructions",
        "The reply has 1 calls: waiting for it to finish | Sent with the tool instructions",
        "Waiting for your Run: list_directory",
        "Running list_directory (1/1)",
        "Sending the results",
        "The page is writing the reply | Sent with the tool results",
        "Done: the reply has no call",
      ]);
      // and it goes away
      await flowBox(c.page).waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await c.page.close();
    }
  });

  it("the page changed since it was learned: no reply is found, and the status line says what can be done", async () => {
    const c = await open({ replies: ["Hello."] });
    try {
      await learn(c.page);
      await closeResults(c.page);
      // replies now look different from what was learned
      await c.page.evaluate(() => ((window as unknown as MockWindow).__replyClass = "bot"));
      await type(c.page, "hello");
      await c.page.keyboard.press("Enter");
      await waitSent(c.page, 2);
      const stuck = flowBox(c.page).filter({ hasText: "No reply found yet" });
      await stuck.waitFor({ timeout: 20_000 });
      assert.match((await stuck.textContent()) ?? "", /learn the page/);
      await c.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: SITE });
      await stuck.getByRole("button", { name: "Copy page structure" }).click();
      await stuck.getByRole("button", { name: "✓ Copied" }).waitFor();
      assert.match(await c.page.evaluate(() => navigator.clipboard.readText()), /chat-app\n\s+#shadow-root\n/);
      await stuck.getByRole("button", { name: "Learn again" }).click();
      await box(c.page).filter({ hasText: "Learning this page" }).waitFor();
    } finally {
      await c.page.close();
    }
  });

  it("what it learned is not on the page: it guesses, and says so", async () => {
    const bogus: Layout = { v: 1, at: Date.now(), input: ["nothing-here"], send: ["nothing-here"], list: ["nothing-here"], mine: "div.nothing", reply: "div.nothing-either", code: "pre" };
    await h.worker.evaluate((l) => chrome.storage.local.set({ layouts: { "https://chat.example.test": l } }), bogus);
    await h.setSettings(auto("list_directory"));
    const c = await open({ replies: [call("list_directory", { path: h.dir }), "There is a-file.txt."] });
    try {
      await type(c.page, "What is in my folder?");
      await c.page.keyboard.press("Enter");
      await c.page.locator("gmb-status .flow").filter({ hasText: "What it learned is not on the page" }).waitFor({ timeout: 15_000 });
      await waitSent(c.page, 2);
      assert.match((await sent(c.page))[1], /^\[MCP Bridge · results\]\n#1 list_directory → ok/);
      assert.ok(c.logs.some((l) => /reply finished 1 guessed/.test(l)), c.logs.join("\n"));
    } finally {
      await c.page.close();
    }
  });
});
