// Against the real gemini.google.com (signed out): Gemini has to find a word that exists only in a file on this
// computer, through list_directory and read_file. Runs only with GMB_LIVE=1: it depends on Google's service.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startHarness, type Harness } from "./harness.ts";

const live = process.env.GMB_LIVE === "1";

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
    await page.goto("https://gemini.google.com/app");
    const editor = page.locator("rich-textarea .ql-editor");
    await editor.waitFor({ timeout: 30_000 });
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
    await page.goto("https://gemini.google.com/app");
    const editor = page.locator("rich-textarea .ql-editor");
    await editor.waitFor({ timeout: 30_000 });
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
