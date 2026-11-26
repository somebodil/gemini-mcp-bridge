// Learning a page in generic mode, against the mock chat page: the user sends one test message while the extension
// only watches; what it learned is kept for the site, listed with how sure it is, and outlined on the page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import type { Layout } from "../src/content/layout.ts";
import { MARK } from "../src/shared/protocol.ts";
import { startHarness, type Harness } from "./harness.ts";
import { box, button, closeResults, learn, sendTest, startLearning } from "./learning.ts";

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

async function open(path = "/"): Promise<Page> {
  const page = await h.context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("gmb-debug", "1");
    Object.assign(window, { __stepMs: 300 });
  });
  await page.goto(SITE + path);
  assert.equal(await h.toggle(page), true);
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return page;
}

const found = (page: Page, role: string) => page.locator(`gmb-status .roles li[data-role="${role}"]`).getAttribute("data-found");

async function stored(): Promise<Layout | undefined> {
  const all = await h.worker.evaluate(async () => (await chrome.storage.local.get("layouts")).layouts as Record<string, Layout> | undefined);
  return all?.[SITE];
}

/** Where a locator leads in the page's own world: an element, or the host of a closed shadow root it goes into. */
function where(page: Page, loc: string[] | undefined): Promise<string> {
  return page.evaluate((loc) => {
    if (!loc) return "none";
    let tree: Document | ShadowRoot = document;
    let el: Element | null = null;
    for (let i = 0; i < loc.length; i++) {
      el = tree.querySelector(loc[i]);
      if (!el) return "none";
      if (i < loc.length - 1) {
        if (!el.shadowRoot) return `closed ${el.localName}`;
        tree = el.shadowRoot;
      }
    }
    return el ? [el.localName, ...el.classList].join(".") : "none";
  }, loc);
}

/** The elements of the mock's list that each pattern matches. */
function kinds(page: Page, l: Layout): Promise<Record<"mine" | "reply" | "code", string[]>> {
  return page.evaluate((l) => {
    const root = document.querySelector("chat-app")?.shadowRoot;
    const of = (sel?: string) => (sel && root ? [...root.querySelectorAll("*")].filter((e) => e.matches(sel)).map((e) => [e.localName, ...e.classList].join(".")) : []);
    return { mine: of(l.mine), reply: of(l.reply), code: of(l.code) };
  }, l);
}

describe("learning a page", () => {
  it("learns every part from one test message, keeps it for the site and outlines it", async () => {
    const page = await open();
    try {
      await startLearning(page);
      assert.match((await box(page).textContent()) ?? "", /only watches/);
      await sendTest(page);
      // the steps were all seen
      for (const step of ["input", "send", "busy", "mine", "reply", "code", "end"]) {
        assert.equal(await page.locator(`gmb-status .steps li[data-step="${step}"]`).getAttribute("class"), "done", step);
      }
      await button(page, "Stop learning").click();
      await box(page).filter({ hasText: "What the extension learned" }).waitFor();
      for (const role of ["input", "send", "busy", "list", "mine", "reply", "code"]) assert.equal(await found(page, role), "ok", role);

      const l = await stored();
      assert.ok(l, "a layout for the site");
      // the reply said which AI answers here
      assert.equal(l.ai, "claude");
      assert.match((await box(page).textContent()) ?? "", /The AI here says it is Claude\./);
      assert.equal(await where(page, l.input), "textarea");
      assert.equal(await where(page, l.send), "closed icon-button");
      assert.match(await where(page, l.busy?.at), /icon-button/);
      assert.match(l.busy?.look ?? "", /stop/);
      assert.equal(await where(page, l.list), "div.log");
      assert.deepEqual(await kinds(page, l), { mine: ["div.msg.user"], reply: ["div.msg.model"], code: ["pre"] });

      // outlined on the page
      const roles = await page.locator("gmb-overlay .box").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.role));
      for (const role of ["input", "send", "list", "mine", "reply", "code"]) assert.ok(roles.includes(role), `${role} outlined: ${roles.join(",")}`);

      // the test message went as it was, and nothing ran
      const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /^This is a test from the Gemini MCP Bridge extension/);
      assert.ok(!sent[0].includes(MARK.instructions));
      assert.deepEqual(h.calls, []);

      // closing takes the outlines away; the panel says the site was learned
      await button(page, "Close").click();
      assert.equal(await page.locator("gmb-overlay").count(), 0);
      assert.equal(await box(page).count(), 0);
      await page.locator("gmb-status .pill").click();
      await page.locator('gmb-status [data-site="learned"][data-ai="claude"]').filter({ hasText: "The AI here: Claude." }).waitFor();
    } finally {
      await page.close();
    }
  });

  it("tells the AI it learned its own folder; learned again as another AI, the next message tells the new one", async () => {
    const page = await open();
    const sent = () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
    const say = async (text: string, n: number) => {
      await page.locator("chat-app textarea").fill(text);
      await page.locator("chat-app textarea").press("Enter");
      await page.waitForFunction((k) => (window as unknown as { __sent: string[] }).__sent.length === k, n);
      // the reply is written out (the instructions reached the conversation), and the page sends again: till then
      // its send button stops the reply
      await page.waitForFunction(
        (k) =>
          (document.querySelector("chat-app")?.shadowRoot?.textContent?.split("Nothing more to say.").length ?? 0) > k &&
          !(document.querySelector("chat-app") as unknown as { generating: boolean }).generating,
        n / 2,
      );
    };
    try {
      await learn(page);
      await closeResults(page);
      await say("hello", 2);
      const first = (await sent())[1];
      assert.ok(first.startsWith(MARK.instructions), first.slice(0, 80));
      assert.match(first, /Your own folder on my computer is ~\/\.claude: your standing instructions are in ~\/\.claude\/CLAUDE\.md, your skills in ~\/\.claude\/skills /);

      await page.evaluate(() => Object.assign(window, { __ai: "ChatGPT" }));
      await page.locator("gmb-status .pill").click();
      await button(page, "Learn again").click();
      await sendTest(page);
      await button(page, "Stop learning").click();
      await box(page).filter({ hasText: "The AI here says it is ChatGPT." }).waitFor();
      assert.equal((await stored())?.ai, "chatgpt");
      await closeResults(page);
      await say("next", 4);
      const update = (await sent())[3];
      assert.ok(update.startsWith(MARK.toolsUpdate), update.slice(0, 80));
      assert.match(update, /~\/\.codex\/AGENTS\.md/);
      assert.doesNotMatch(update, /\.claude/);
    } finally {
      await page.close();
    }
  });

  it("another tab of the site has it at once, and shows what is on its page now", async () => {
    const page = await open();
    const other = await open("/?other");
    try {
      await other.locator("gmb-status .pill").click();
      await other.locator('gmb-status [data-site="guessing"]').waitFor();
      await learn(page);
      // the open panel of the other tab follows
      await other.locator('gmb-status [data-site="learned"]').waitFor();
      await button(other, "What it learned").click();
      await box(other).filter({ hasText: "What the extension learned" }).waitFor();
      assert.equal(await found(other, "input"), "ok");
      assert.equal(await found(other, "send"), "ok");
      // no messages in that tab yet
      assert.equal(await found(other, "mine"), "missing");
      assert.match((await other.locator('gmb-status .roles li[data-role="mine"]').textContent()) ?? "", /Not on the page now/);
    } finally {
      await page.close();
      await other.close();
    }
  });

  it("sent with Enter: the send button is found by its name", async () => {
    const page = await open();
    try {
      await learn(page, "enter");
      assert.equal(await found(page, "send"), "unsure");
      assert.match((await page.locator('gmb-status .roles li[data-role="send"]').textContent()) ?? "", /Enter/);
      assert.equal(await found(page, "busy"), "ok");
      assert.equal(await found(page, "reply"), "ok");
      assert.match(await where(page, (await stored())?.send), /icon-button/);
    } finally {
      await page.close();
    }
  });

  it("stopped before anything was sent: nothing is kept", async () => {
    const page = await open();
    try {
      await startLearning(page);
      await button(page, "Stop learning").click();
      await box(page).filter({ hasText: "Nothing was learned" }).waitFor();
      for (const role of ["input", "send", "busy", "mine", "reply", "code"]) assert.equal(await found(page, role), "missing", role);
      assert.equal(await stored(), undefined);
      await button(page, "Close").click();
      await page.locator("gmb-status .pill").click();
      await page.locator('gmb-status [data-site="guessing"]').waitFor();
    } finally {
      await page.close();
    }
  });

  it("cancelled: the bridge works as before (instructions go with the next message)", async () => {
    const page = await open();
    try {
      await startLearning(page);
      await page.locator("chat-app textarea").click();
      await page.waitForFunction(() => document.querySelector("chat-app")?.shadowRoot?.querySelector("textarea")?.value.includes("gmb_test"));
      await button(page, "Cancel").click();
      assert.equal(await box(page).count(), 0);
      await page.locator("chat-app textarea").fill("hello");
      await page.locator("chat-app textarea").press("Enter");
      await page.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.length === 1);
      const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent[0]);
      assert.ok(sent.includes(MARK.instructions), sent.slice(0, 80));
      assert.equal(await stored(), undefined);
    } finally {
      await page.close();
    }
  });

  it("turning the tab off takes the outlines and the boxes away", async () => {
    const page = await open();
    try {
      await learn(page);
      assert.ok((await page.locator("gmb-overlay .box").count()) > 0);
      assert.equal(await h.toggle(page), false);
      await page.waitForFunction(() => !document.querySelector("gmb-overlay") && !document.querySelector("gmb-status"));
    } finally {
      await page.close();
    }
  });
});

describe("learned pages on the options page", () => {
  it("lists each learned site with what was found; Delete makes its tabs guess again", async () => {
    const other: Layout = { v: 1, at: Date.UTC(2026, 10, 1), input: ["textarea"], send: ["button"], list: ["main"], mine: "div.me", reply: "div.bot", picked: ["reply"] };
    await h.worker.evaluate((l) => chrome.storage.local.set({ layouts: { "https://other.example.test": l } }), other);
    const page = await open();
    const id = new URL(h.worker.url()).host;
    const options = await h.context.newPage();
    try {
      await learn(page);
      await closeResults(page);
      await options.goto(`chrome-extension://${id}/options.html`);
      const row = (site: string) => options.locator(`#layouts tr[data-site="${site}"]`);
      // the site learned just now is there, though the page was opened before
      await row(SITE).waitFor();
      assert.match((await row(SITE).textContent()) ?? "", /AI: Claude · 7 of 7 parts/);
      const about = (await row("https://other.example.test").textContent()) ?? "";
      assert.match(about, /5 of 7 parts/);
      assert.match(about, /not found: Writing indicator, Code block/);
      assert.match(about, /picked by hand: Reply/);
      await page.locator("gmb-status .pill").click();
      await page.locator('gmb-status [data-site="learned"]').waitFor();
      await row(SITE).getByRole("button", { name: "Delete" }).click();
      await row(SITE).waitFor({ state: "detached" });
      assert.equal(await stored(), undefined);
      // the open tab of the site follows
      await page.locator('gmb-status [data-site="guessing"]').waitFor();
      await row("https://other.example.test").getByRole("button", { name: "Delete" }).click();
      await options.getByText("No page learned yet.").waitFor();
    } finally {
      await options.close();
      await page.close();
    }
  });
});
