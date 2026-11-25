// Against the real gemini.google.com (signed out): Gemini has to find a word that exists only in a file on this
// computer, through list_directory and read_file. Runs only with GMB_LIVE=1: it depends on Google's service.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Page } from "playwright";
import { startHarness, type Harness } from "./harness.ts";

const live = process.env.GMB_LIVE === "1";

/** Signed out, Gemini asks now and then to sign in, and sends nothing till it is answered: "Not now", as a user would. */
function dismissSignIn(page: Page): void {
  const timer = setInterval(() => {
    void page
      .getByRole("button", { name: /^(Not now|나중에)$/ })
      .click({ timeout: 500 })
      .catch(() => undefined);
  }, 1000);
  page.on("close", () => clearInterval(timer));
}

describe("real Gemini", { skip: !live && "set GMB_LIVE=1 to run against gemini.google.com" }, () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h?.close();
  });

  it("finds a word that only a file on this computer holds", { timeout: 240_000 }, async () => {
    const word = `zebra-${randomBytes(3).toString("hex")}`;
    writeFileSync(join(h.dir, "note-for-gemini.txt"), `The magic word is ${word}.\n`);
    await h.setSettings({ policies: { list_directory: "auto", read_file: "auto" } });
    const page = await h.context.newPage();
    dismissSignIn(page);
    await page.goto("https://gemini.google.com/app");
    const editor = page.locator("rich-textarea .ql-editor");
    await editor.waitFor({ timeout: 30_000 });
    assert.equal(await h.toggle(page), true);
    await page.locator("gmb-status").waitFor({ state: "attached" });
    // the pill shows the tools once the extension reached the server
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("4 tools"), null, { timeout: 15_000 });
    await editor.click();
    await page.keyboard.type(`What is the magic word in the .txt file in the folder ${h.dir} on my computer?`);
    await page.keyboard.press("Enter");

    await page.waitForFunction(
      (w) => [...document.querySelectorAll("model-response")].some((r) => (r as HTMLElement).innerText.includes(w) && !r.querySelector("code-block")),
      word,
      { timeout: 200_000, polling: 1000 },
    );
    const sent = await page.locator("user-query").allInnerTexts();
    await page.screenshot({ path: join(process.env.SHOTS ?? h.dir, "live.png"), fullPage: false });
    assert.ok(sent.length >= 2, "the extension sent at least one results message");
    const chips = await page.locator(".gmb-chip").allInnerTexts();
    assert.ok(chips.some((c) => c.includes("MCP Bridge instructions")), `instruction chip: ${chips.join(" | ")}`);
    assert.ok(chips.some((c) => c.includes("Tool results")), `results chip: ${chips.join(" | ")}`);
    const cards = await page.locator("gmb-card").evaluateAll((els) => els.map((e) => e.shadowRoot?.textContent ?? ""));
    assert.ok(cards.length >= 1 && cards.every((c) => c.includes("Done")), `cards: ${cards.join(" | ")}`);
  });
});

describe("real Gemini, Korean, with approvals", { skip: !live && "set GMB_LIVE=1 to run against gemini.google.com" }, () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ locale: "ko-KR" });
  });
  after(async () => {
    await h?.close();
  });

  it("asks before each call and runs on 실행", { timeout: 240_000 }, async () => {
    const word = `고양이-${randomBytes(2).toString("hex")}`;
    writeFileSync(join(h.dir, "메모.txt"), `비밀 단어는 ${word} 입니다.\n`);
    const page = await h.context.newPage();
    dismissSignIn(page);
    await page.goto("https://gemini.google.com/app");
    const editor = page.locator("rich-textarea .ql-editor");
    await editor.waitFor({ timeout: 30_000 });
    assert.equal(await h.toggle(page), true);
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("도구 4개"), null, { timeout: 15_000 });
    await editor.click();
    await page.keyboard.type(`내 컴퓨터의 ${h.dir} 폴더에 있는 txt 파일에 적힌 비밀 단어가 뭐야?`);
    await page.keyboard.press("Enter");
    // Gemini needs two calls (list, read); each waits for a click. A third, if Gemini wants one, too.
    const answered = () =>
      page.evaluate((w) => [...document.querySelectorAll("model-response")].some((r) => (r as HTMLElement).innerText.includes(w) && !r.querySelector("code-block")), word);
    let clicks = 0;
    for (let i = 0; i < 4 && !(await answered()); i++) {
      const run = page.locator("gmb-card").last().getByRole("button", { name: "실행", exact: true });
      const next = await Promise.race([
        run.waitFor({ timeout: 120_000 }).then(() => "ask" as const),
        page.waitForFunction((w) => [...document.querySelectorAll("model-response")].some((r) => (r as HTMLElement).innerText.includes(w)), word, { timeout: 120_000 }).then(() => "done" as const),
      ]);
      if (next === "done") break;
      if (i === 0) await page.screenshot({ path: join(process.env.SHOTS ?? h.dir, "live-ko-ask.png") });
      await run.click();
      clicks++;
    }
    await page.waitForFunction((w) => [...document.querySelectorAll("model-response")].some((r) => (r as HTMLElement).innerText.includes(w) && !r.querySelector("code-block")), word, {
      timeout: 120_000,
    });
    await page.screenshot({ path: join(process.env.SHOTS ?? h.dir, "live-ko-done.png") });
    assert.ok(clicks >= 1, "at least one call waited for 실행");
    const chips = await page.locator(".gmb-chip").allInnerTexts();
    assert.ok(chips.some((c) => c.includes("MCP Bridge 지침")), chips.join(" | "));
  });
});

// The generic mode (for Gemini Enterprise and other pages the extension does not know), tried on the real
// gemini.google.com: the extension is told not to use what it knows of the page.
describe("real Gemini in generic mode", { skip: !live && "set GMB_LIVE=1 to run against gemini.google.com" }, () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h?.close();
  });

  it("finds the word with nothing but the generic page rules", { timeout: 240_000 }, async () => {
    const word = `otter-${randomBytes(3).toString("hex")}`;
    writeFileSync(join(h.dir, "note-for-gemini.txt"), `The magic word is ${word}.\n`);
    await h.setSettings({ policies: { list_directory: "auto", read_file: "auto" } });
    const page = await h.context.newPage();
    dismissSignIn(page);
    page.on("console", (msg) => {
      if (msg.text().startsWith("[gmb]") && process.env.GMB_LOGS) console.log(msg.text());
    });
    await page.addInitScript(() => {
      localStorage.setItem("gmb-generic", "1");
      localStorage.setItem("gmb-debug", "1");
    });
    await page.goto("https://gemini.google.com/app");
    const editor = page.locator("rich-textarea .ql-editor");
    await editor.waitFor({ timeout: 30_000 });
    assert.equal(await h.toggle(page), true);
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("4 tools"), null, { timeout: 15_000 });
    await editor.click();
    await page.keyboard.type(`What is the magic word in the .txt file in the folder ${h.dir} on my computer?`);
    await page.keyboard.press("Enter");
    try {
      await page.waitForFunction(
        (w) => [...document.querySelectorAll("model-response")].some((r) => (r as HTMLElement).innerText.includes(w) && !r.querySelector("code-block")),
        word,
        { timeout: 200_000, polling: 1000 },
      );
    } finally {
      await page.screenshot({ path: join(process.env.SHOTS ?? h.dir, "live-guessed.png"), fullPage: false });
    }
    const sent = await page.locator("user-query").allInnerTexts();
    assert.ok(sent.length >= 2, "the extension sent at least one results message");
    assert.equal(await page.locator(".gmb-chip").count(), 0, "no chips in generic mode");
    const cards = await page.locator("gmb-card").evaluateAll((els) => els.map((e) => e.shadowRoot?.textContent ?? ""));
    assert.ok(cards.length >= 1 && cards.some((c) => c.includes("Done")), `cards: ${cards.join(" | ")}`);
  });
});

describe("real Gemini as an unknown page, learned first", { skip: !live && "set GMB_LIVE=1 to run against gemini.google.com" }, () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h?.close();
  });

  it("learns the page from the test message, then finds the word with what it learned", { timeout: 360_000 }, async () => {
    const word = `otter-${randomBytes(3).toString("hex")}`;
    writeFileSync(join(h.dir, "note-for-gemini.txt"), `The magic word is ${word}.\n`);
    await h.setSettings({ policies: { list_directory: "auto", read_file: "auto" } });
    const page = await h.context.newPage();
    dismissSignIn(page);
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().startsWith("[gmb]")) logs.push(msg.text());
    });
    // the generic mode, as on any page the extension does not know
    await page.addInitScript(() => {
      localStorage.setItem("gmb-generic", "1");
      localStorage.setItem("gmb-debug", "1");
    });
    await page.goto("https://gemini.google.com/app");
    const editor = page.locator("rich-textarea .ql-editor");
    await editor.waitFor({ timeout: 30_000 });
    assert.equal(await h.toggle(page), true);
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("4 tools"), null, { timeout: 15_000 });

    // learning: the test message goes in where the user clicks, and out with the send button
    const learnBox = page.locator("gmb-status .learn");
    await page.locator("gmb-status .pill").click();
    await page.locator("gmb-status button", { hasText: "Learn this page" }).click();
    await editor.click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>("rich-textarea .ql-editor")?.innerText.includes("gmb_test"));
    await page.getByRole("button", { name: /send message/i }).click();
    await learnBox.filter({ hasText: "Everything seen" }).waitFor({ timeout: 120_000 });
    await page.locator("gmb-status button", { hasText: "Stop learning" }).click();
    await learnBox.filter({ hasText: "What the extension learned" }).waitFor();
    const roles = await page.locator("gmb-status .roles li").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-role")}=${e.getAttribute("data-found")}: ${(e as HTMLElement).innerText.replace(/\s+/g, " ")}`));
    const layouts = await h.worker.evaluate(async () => (await chrome.storage.local.get("layouts")).layouts as Record<string, unknown>);
    console.log(`learned:\n${roles.join("\n")}\n${JSON.stringify(layouts["https://gemini.google.com"], null, 1)}`);
    await page.screenshot({ path: join(process.env.SHOTS ?? h.dir, "live-learned.png"), fullPage: false });
    for (const role of ["input", "send", "mine", "reply", "code"]) {
      assert.ok(roles.some((r) => r.startsWith(`${role}=ok`) || r.startsWith(`${role}=unsure`)), `${role} learned: ${roles.join(" | ")}`);
    }
    await page.locator("gmb-status button", { hasText: "Close" }).click();

    // operating with what was learned
    try {
      await editor.click();
      await page.keyboard.type(`What is the magic word in the .txt file in the folder ${h.dir} on my computer?`);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (w) => [...document.querySelectorAll("model-response")].some((r) => (r as HTMLElement).innerText.includes(w) && !r.querySelector("code-block")),
        word,
        { timeout: 200_000, polling: 1000 },
      );
    } finally {
      await page.screenshot({ path: join(process.env.SHOTS ?? h.dir, "live-generic.png"), fullPage: false });
      const flow = await page.evaluate(() => document.querySelector("gmb-status")?.shadowRoot?.querySelector(".flow")?.textContent ?? "");
      console.log(`status line: ${flow}\nsent: ${JSON.stringify(await page.locator("user-query").allInnerTexts()).slice(0, 2000)}\n${logs.join("\n").slice(-6000)}`);
    }
    assert.ok(logs.some((l) => /reply finished \d+ learned/.test(l)), "replies were found by what was learned");
    const cards = await page.locator("gmb-card").evaluateAll((els) => els.map((e) => e.shadowRoot?.textContent ?? ""));
    assert.ok(cards.length >= 1 && cards.every((c) => c.includes("Done")), `cards: ${cards.join(" | ")}`);
  });
});
