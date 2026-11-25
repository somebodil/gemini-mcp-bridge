// The extension in Chromium against a page that copies the parts of gemini.google.com it relies on, with
// scripted replies: deterministic, no Google account, no network. Clicks are real input events (Playwright),
// as the extension ignores clicks made by scripts.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import { MARK } from "../src/shared/protocol.ts";
import { startHarness, type Harness } from "./harness.ts";

const MOCK = readFileSync(join(import.meta.dirname, "mock-gemini.html"), "utf8");
const call = (tool: string, args: Record<string, unknown>) => `Let me check.\n\`\`\`json\n${JSON.stringify({ mcp_call: { tool, arguments: args } })}\n\`\`\``;

let h: Harness;

before(async () => {
  h = await startHarness();
  await h.context.route("https://gemini.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: MOCK }));
  writeFileSync(join(h.dir, "a-file.txt"), "content of a file\n");
});
after(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.setSettings({});
  h.calls.length = 0;
});

type MockWindow = { __replies: string[]; __initial: string[]; __sent: string[]; __delay?: number; __openOld(m: ({ user: string } | { model: string })[]): void };

async function open(replies: string[], initial: string[] = [], delay = 500): Promise<Page> {
  const page = await h.context.newPage();
  await page.addInitScript(
    ([r, i, d]) => {
      const w = window as unknown as MockWindow;
      w.__replies = r;
      w.__initial = i;
      w.__delay = d;
    },
    [replies, initial, delay] as const,
  );
  await page.goto("https://gemini.google.com/app");
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return page;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator("rich-textarea .ql-editor").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__sent);
const waitSent = (page: Page, n: number) => page.waitForFunction((k) => (window as unknown as MockWindow).__sent.length >= k, n, { timeout: 15_000 });
const lastCard = (page: Page) => page.locator("gmb-card").last();
const cardButton = (page: Page, label: string) => lastCard(page).getByRole("button", { name: label, exact: true }).click({ timeout: 10_000 });
const cardTexts = (page: Page) => page.locator("gmb-card").evaluateAll((els) => els.map((e) => e.shadowRoot?.querySelector(".card")?.textContent ?? ""));
const pillText = (page: Page) => page.evaluate(() => document.querySelector("gmb-status")?.shadowRoot?.textContent ?? "");

describe("with a mock Gemini", () => {
  it("adds the instructions, asks, runs on Run, sends the results, and stops at the answer", async () => {
    const page = await open([call("list_directory", { path: h.dir }), "There is a-file.txt."]);
    await say(page, "What is in my folder?");
    await waitSent(page, 1);
    const [first] = await sent(page);
    assert.ok(first.startsWith(MARK.instructions), first.slice(0, 80));
    assert.match(first, /- list_directory: List the files and folders in a folder\./);
    assert.ok(first.endsWith("What is in my folder?"));
    await cardButton(page, "Run");
    await waitSent(page, 2);
    const second = (await sent(page))[1];
    assert.ok(second.startsWith(`${MARK.results}\n#1 list_directory → ok`), second.slice(0, 80));
    assert.match(second, /\[FILE\] a-file\.txt \(18 bytes\)/);
    await page.waitForTimeout(2500);
    assert.equal((await sent(page)).length, 2, "nothing is sent after an answer without calls");
    assert.match((await cardTexts(page))[0], /list_directory.*Done/);
    const chips = await page.locator(".gmb-chip").allInnerTexts();
    assert.deepEqual(chips, ["🔧 MCP Bridge instructions · 4 tools", "🔧 Tool results: list_directory ✓"]);
    const visible = await page.locator("user-query").first().locator(".query-text-line:visible").allInnerTexts();
    assert.deepEqual(
      visible.filter((x) => x.trim()),
      ["What is in my folder?"],
    );
    await page.close();
  });

  it("sends the instructions once per conversation", async () => {
    const page = await open(["Hello.", "Hi again."]);
    await say(page, "first");
    await waitSent(page, 1);
    await page.waitForTimeout(1500);
    await say(page, "second");
    await waitSent(page, 2);
    const s = await sent(page);
    assert.ok(s[0].startsWith(MARK.instructions));
    assert.equal(s[1], "second");
    await page.close();
  });

  it("sends a refusal when the user denies", async () => {
    const page = await open([call("run_command", { command: "echo hi" }), "OK."]);
    await say(page, "run something");
    await cardButton(page, "Deny");
    await waitSent(page, 2);
    assert.match((await sent(page))[1], /#1 run_command → error\n```text\nThe user declined this call\./);
    assert.deepEqual(h.calls, []);
    await page.close();
  });

  it("remembers Always allow", async () => {
    const page = await open([call("run_command", { command: "echo always" }), "Done."]);
    await say(page, "run it");
    await cardButton(page, "Always allow");
    await waitSent(page, 2);
    assert.match((await sent(page))[1], /exit code: 0\n--- stdout ---\nalways/);
    const policies = await h.worker.evaluate(async () => ((await chrome.storage.local.get("settings")).settings as { policies: Record<string, string> }).policies);
    assert.equal(policies.run_command, "auto");
    await page.close();
  });

  it("runs auto tools without asking, several calls in order", async () => {
    await h.setSettings({ policies: { read_file: "auto", list_directory: "auto" } });
    const two = `${call("list_directory", { path: h.dir })}\n${call("read_file", { path: join(h.dir, "a-file.txt") })}`;
    const page = await open([two, "Done."]);
    await say(page, "look");
    await waitSent(page, 2);
    assert.match((await sent(page))[1], /#1 list_directory → ok[\s\S]*#2 read_file → ok\n```text\ncontent of a file/);
    await page.close();
  });

  it("answers an unreadable call with an error that Gemini can act on", async () => {
    const page = await open(['```json\n{"mcp_call": {"tool": "read_file", "arguments": {"path": }}}\n```', "Sorry."]);
    await say(page, "read");
    await waitSent(page, 2);
    assert.match((await sent(page))[1], /#1 mcp_call → error\n```text\nThe block is not valid JSON\.\nYou wrote: /);
    await page.close();
  });

  it("tells Gemini about a tool that does not exist", async () => {
    const page = await open([call("format_disk", {}), "OK."]);
    await say(page, "x");
    await waitSent(page, 2);
    assert.match((await sent(page))[1], /There is no tool named "format_disk"\. Available tools: run_command, read_file, write_file, list_directory\./);
    await page.close();
  });

  it("keeps the user's draft, and sends the results with it on a click", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open([call("list_directory", { path: h.dir }), "Done."]);
    await say(page, "go");
    await waitSent(page, 1);
    await page.locator("rich-textarea .ql-editor").click();
    await page.keyboard.type("my draft");
    await page.locator("gmb-status").getByRole("button", { name: "Send results" }).click({ timeout: 10_000 });
    await waitSent(page, 2);
    const r = (await sent(page))[1];
    assert.ok(r.startsWith(MARK.results) && r.endsWith("my draft"), r.slice(-40));
    await page.close();
  });

  it("puts waiting results in front of the draft when the user sends it", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open([call("list_directory", { path: h.dir }), "Done."]);
    await say(page, "go");
    await waitSent(page, 1);
    await page.locator("rich-textarea .ql-editor").click();
    await page.keyboard.type("my draft");
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("Send results"), null, { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await waitSent(page, 2);
    const r = (await sent(page))[1];
    assert.ok(r.startsWith(MARK.results) && r.endsWith("my draft"), r.slice(0, 60));
    assert.doesNotMatch(await pillText(page), /Send results/);
    // the user's own line stays visible, the results fold into a chip
    await page.locator("user-query").last().locator(".gmb-chip").waitFor();
    const visible = await page.locator("user-query").last().locator(".query-text-line:visible").allInnerTexts();
    assert.deepEqual(
      visible.filter((x) => x.trim()),
      ["my draft"],
    );
    await page.close();
  });
});

describe("approval cannot be skipped", () => {
  it("a script of the page cannot press Run", async () => {
    const page = await open([call("run_command", { command: "echo forged" }), "OK."]);
    await say(page, "x");
    await lastCard(page).getByRole("button", { name: "Run", exact: true }).waitFor();
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const b = [...(document.querySelector("gmb-card")?.shadowRoot?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Run");
      (b as HTMLButtonElement).click();
    });
    await page.waitForTimeout(1500);
    assert.deepEqual(h.calls, []);
    assert.equal((await sent(page)).length, 1);
    await page.close();
  });

  it("a key pressed while typing does not answer the question", async () => {
    const page = await open([call("run_command", { command: "echo key" }), "OK."]);
    await say(page, "x");
    await lastCard(page).getByRole("button", { name: "Run", exact: true }).waitFor();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    assert.deepEqual(h.calls, []);
    await page.close();
  });

  it("the service worker refuses an 'ask' tool without approval, whatever the page believes", async () => {
    const id = new URL(h.worker.url()).host;
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    const viaPort = (approved: boolean, tool = "run_command") =>
      page.evaluate(
        ([a, n]) =>
          new Promise<{ ok: boolean; needsApproval?: boolean; text: string }>((resolve) => {
            const port = chrome.runtime.connect({ name: "call" });
            port.onMessage.addListener((m: { type: string; ok: boolean; needsApproval?: boolean; text: string }) => {
              if (m.type === "result") resolve(m);
            });
            port.postMessage({ type: "call", tool: n, arguments: { command: "echo via-port" }, approved: a });
          }),
        [approved, tool] as const,
      );
    const refused = await viaPort(false);
    assert.equal(refused.needsApproval, true);
    assert.deepEqual(h.calls, []);
    assert.match((await viaPort(true)).text, /via-port/);
    await h.setSettings({ policies: { run_command: "off" } });
    const off = await viaPort(true);
    assert.equal(off.ok, false);
    assert.match(off.text, /no tool named "run_command"/);
    await page.close();
  });
});

describe("only the answer to a message this tab sent", () => {
  it("never runs the calls of a conversation that was already on the page", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open([], [call("run_command", { command: "echo old" })]);
    await page.waitForTimeout(3000);
    assert.equal((await sent(page)).length, 0);
    assert.match((await cardTexts(page))[0], /Earlier call/);
    await page.close();
  });

  it("does not run an old reply's call when the user sends a new message", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open(["Hi."], [call("run_command", { command: "echo old" })], 2500);
    await say(page, "hello");
    await waitSent(page, 1);
    await page.waitForTimeout(4500);
    assert.deepEqual(h.calls, []);
    assert.equal((await sent(page)).length, 1);
    await page.close();
  });

  it("does not run the calls of an old chat opened while waiting in a new one", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open(["Hi."], [], 1500);
    await say(page, "hello");
    await waitSent(page, 1);
    await page.evaluate(() => (window as unknown as MockWindow).__openOld([{ user: "old question" }, { model: "```json\n" + '{"mcp_call": {"tool": "run_command", "arguments": {"command": "echo old-chat"}}}' + "\n```" }]));
    await page.waitForTimeout(4000);
    assert.deepEqual(h.calls, []);
    assert.equal((await sent(page)).length, 1);
    await page.close();
  });

  it("does not send the results of one chat into another", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open([call("run_command", { command: "sleep 2; echo A-SECRET" })]);
    await say(page, "slow");
    await page.waitForFunction(() => [...document.querySelectorAll("gmb-card")].some((c) => c.shadowRoot?.textContent?.includes("Running")), null, { timeout: 10_000 });
    await page.evaluate(() => (window as unknown as MockWindow).__openOld([{ user: "other chat" }, { model: "Other answer." }]));
    await page.waitForTimeout(4000);
    assert.equal((await sent(page)).length, 1, "no results went into the other chat");
    await page.close();
  });

  it("does nothing in a new chat where the user turned it off, also for the reply", async () => {
    await h.setSettings({ autoRunAll: true });
    const page = await open([call("run_command", { command: "echo off" })]);
    await page.evaluate(() => sessionStorage.setItem("gmb-off:new", "1"));
    await say(page, "plain message");
    await waitSent(page, 1);
    assert.equal((await sent(page))[0], "plain message");
    await page.waitForTimeout(3500);
    assert.deepEqual(h.calls, []);
    assert.equal((await sent(page)).length, 1);
    await page.close();
  });
});

describe("loop guard and sends", () => {
  it("pauses before running the calls of a reply past the limit", async () => {
    await h.setSettings({ autoRunAll: true, maxRounds: 2 });
    const loop = call("list_directory", { path: h.dir });
    const page = await open([loop, loop, loop, loop]);
    await say(page, "loop");
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("Paused after 2"), null, { timeout: 20_000 });
    assert.equal((await sent(page)).length, 3, "the user's message and two results");
    assert.equal(h.calls.length, 2, "the third reply's call waits");
    await page.locator("gmb-status").getByRole("button", { name: "Continue" }).click();
    await waitSent(page, 4);
    assert.equal(h.calls.length, 3);
    await page.close();
  });

  it("sends one message when Enter is pressed twice", async () => {
    const page = await open(["Hello."]);
    await page.locator("rich-textarea .ql-editor").click();
    await page.keyboard.type("once");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await waitSent(page, 1);
    await page.waitForTimeout(1500);
    const s = await sent(page);
    assert.equal(s.length, 1);
    assert.equal(s[0].split(MARK.instructions).length - 1, 1);
    await page.close();
  });
});
