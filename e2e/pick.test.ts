// Picking parts of the page by hand after learning (generic mode, the mock chat page): the (?) table of what to pick,
// the picker (a click goes to the picker, not the page; ↑ goes one layer out; ← and → go to the element before and
// after; Enter picks; Esc cancels), and what a picked part does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import type { Layout } from "../src/content/layout.ts";
import { startHarness, type Harness } from "./harness.ts";
import { box, button, learn } from "./learning.ts";

const MOCK = readFileSync(join(import.meta.dirname, "mock-chat.html"), "utf8");
const SITE = "https://chat.example.test";

let h: Harness;

before(async () => {
  h = await startHarness();
  await h.context.route(`${SITE}/**`, (route) => route.fulfill({ contentType: "text/html", body: MOCK }));
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

async function open(replies: string[] = []): Promise<Page> {
  const page = await h.context.newPage();
  await page.addInitScript((r) => {
    localStorage.setItem("gmb-debug", "1");
    Object.assign(window, { __stepMs: 300, __replies: r });
  }, replies);
  await page.goto(`${SITE}/`);
  assert.equal(await h.toggle(page), true);
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return page;
}

async function stored(): Promise<Layout | undefined> {
  const all = await h.worker.evaluate(async () => (await chrome.storage.local.get("layouts")).layouts as Record<string, Layout> | undefined);
  return all?.[SITE];
}

const row = (page: Page, role: string) => page.locator(`gmb-status .roles li[data-role="${role}"]`);
const picking = (page: Page) => box(page).filter({ hasText: "Picking:" });

/** Starts picking `role` from the list of what was learned. */
async function pick(page: Page, role: string): Promise<void> {
  await row(page, role).getByRole("button", { name: "Pick", exact: true }).click();
  await picking(page).waitFor();
}

/** Points at the middle of what `selector` finds (through open shadow roots). */
async function pointAt(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const b = await page.locator(selector).last().boundingBox();
  assert.ok(b, selector);
  const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(at.x, at.y);
  return at;
}

/** The elements of the mock's list that `pattern` matches. */
function matching(page: Page, pattern: string | undefined): Promise<string[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector("chat-app")?.shadowRoot;
    return sel && root ? [...root.querySelectorAll("*")].filter((e) => e.matches(sel)).map((e) => [e.localName, ...e.classList].join(".")) : [];
  }, pattern);
}

describe("picking parts by hand", () => {
  it("(?) shows the table of parts above the list, the part's row standing out", async () => {
    const page = await open();
    try {
      await learn(page);
      const help = page.locator("gmb-status .help");
      assert.equal(await help.isVisible(), false);
      await row(page, "reply").getByRole("button", { name: "What to pick" }).hover();
      await help.waitFor();
      assert.equal(await help.locator("tbody tr").count(), 7);
      assert.equal(await help.locator("tr.this").getAttribute("data-role"), "reply");
      assert.match((await help.locator("tr.this").textContent()) ?? "", /The whole reply, its text and code blocks together/);
      // above the list
      const helpBox = await help.boundingBox();
      const listBox = await box(page).boundingBox();
      assert.ok(helpBox && listBox && helpBox.y + helpBox.height <= listBox.y + 1, "the table is above the list");
      await page.mouse.move(10, 10);
      await help.waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  });

  it("↑ goes one layer out and Enter picks: the kind is made from the picked element", async () => {
    const page = await open();
    try {
      await learn(page);
      await pick(page, "reply");
      // the text of the reply, then one layer out: the whole reply
      await pointAt(page, "chat-app .msg.model p");
      await page.locator("gmb-status .learn .current").filter({ hasText: /^p \(text/ }).waitFor();
      await page.keyboard.press("ArrowUp");
      await picking(page).filter({ hasText: "div.msg.model" }).waitFor();
      await page.keyboard.press("Enter");
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      assert.equal(await row(page, "reply").getAttribute("data-found"), "ok");
      assert.match((await row(page, "reply").textContent()) ?? "", /Picked by hand/);
      const l = await stored();
      assert.deepEqual(l?.picked, ["reply"]);
      assert.deepEqual(await matching(page, l?.reply), ["div.msg.model"]);
    } finally {
      await page.close();
    }
  });

  it("← and → go to the element before and after in the same layer, and stay at its ends", async () => {
    const page = await open();
    try {
      await learn(page);
      await pick(page, "mine");
      // from the text of the reply: out to the whole reply, then to the message before it (the user's)
      await pointAt(page, "chat-app .msg.model p");
      await page.keyboard.press("ArrowUp");
      await picking(page).filter({ hasText: "div.msg.model" }).waitFor();
      await page.keyboard.press("ArrowLeft");
      await picking(page).filter({ hasText: "div.msg.user" }).waitFor();
      // nothing before the first message: it stays
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
      await picking(page).filter({ hasText: "div.msg.model" }).waitFor();
      // nothing after the last one either
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      await picking(page).filter({ hasText: "div.msg.user" }).waitFor();
      // ↓ goes into this message, not back to the reply ↑ came from
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => !document.querySelector("gmb-status")?.shadowRoot?.querySelector(".learn .current")?.textContent?.includes("div.msg"));
      assert.doesNotMatch((await page.locator("gmb-status .learn .current").textContent()) ?? "", /model/);
      await page.keyboard.press("ArrowUp");
      await picking(page).filter({ hasText: "div.msg.user" }).waitFor();
      await page.keyboard.press("Enter");
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      const l = await stored();
      assert.deepEqual(l?.picked, ["mine"]);
      assert.deepEqual(await matching(page, l?.mine), ["div.msg.user"]);
    } finally {
      await page.close();
    }
  });

  it("a click while picking goes to the picker, not to the page", async () => {
    const page = await open();
    try {
      await learn(page);
      await page.locator("chat-app textarea").fill("a draft");
      await pick(page, "send");
      const at = await pointAt(page, "chat-app icon-button");
      await page.mouse.click(at.x, at.y);
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      // nothing went out, and the draft is as it was
      assert.equal((await page.evaluate(() => (window as unknown as MockWindow).__sent)).length, 1);
      assert.equal(await page.locator("chat-app textarea").inputValue(), "a draft");
      assert.deepEqual((await stored())?.picked, ["send"]);
      assert.equal(await page.locator("gmb-picker").count(), 0);
    } finally {
      await page.close();
    }
  });

  it("Esc cancels: nothing changes", async () => {
    const page = await open();
    try {
      await learn(page);
      const before = await stored();
      await pick(page, "code");
      await pointAt(page, "chat-app .msg.model");
      await page.keyboard.press("Escape");
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      assert.equal(await page.locator("gmb-picker").count(), 0);
      assert.deepEqual(await stored(), before);
      await button(page, "Pick").first().waitFor();
    } finally {
      await page.close();
    }
  });

  it("the input box: a box around it will do", async () => {
    const page = await open();
    try {
      await learn(page);
      await pick(page, "input");
      await pointAt(page, "chat-app textarea");
      await page.keyboard.press("ArrowUp");
      await picking(page).filter({ hasText: "div.bar" }).waitFor();
      await page.keyboard.press("Enter");
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      assert.equal(await row(page, "input").getAttribute("data-found"), "ok");
      assert.match((await row(page, "input").textContent()) ?? "", /textarea/);
    } finally {
      await page.close();
    }
  });

  it("the writing indicator picked while the page waits: the page writes while it looks otherwise", async () => {
    const page = await open(["Hello there."]);
    try {
      await learn(page);
      await pick(page, "busy");
      const at = await pointAt(page, "chat-app icon-button");
      await page.mouse.click(at.x, at.y);
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      const l = await stored();
      assert.equal(l?.busy?.look, undefined);
      assert.equal(l?.busy?.idle, "send");
      await button(page, "Close").click();
      await page.locator("chat-app textarea").fill("hello");
      await page.locator("chat-app textarea").press("Enter");
      await page.locator("gmb-status .flow").filter({ hasText: "The page is writing the reply" }).waitFor({ timeout: 10_000 });
      await page.locator("gmb-status .flow").filter({ hasText: "Done: the reply has no call" }).waitFor({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  });
});
