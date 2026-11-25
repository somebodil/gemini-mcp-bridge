// The generic mode, for chat pages the extension does not know (Gemini Enterprise and the like), against a page
// built unlike gemini.google.com: everything in shadow roots, a textarea, an icon button (in a closed shadow root)
// that turns into a stop button, user messages shown as markdown, replies written out bit by bit, the whole list
// drawn anew on every change. Same rules as on Gemini: only the answer to a message this tab sent, and the same
// approvals.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import type { Settings } from "../src/shared/config.ts";
import { MARK } from "../src/shared/protocol.ts";
import { startHarness, type Harness } from "./harness.ts";

const MOCK = readFileSync(join(import.meta.dirname, "mock-chat.html"), "utf8");
const call = (tool: string, args: Record<string, unknown>) => `Let me check.\n\`\`\`json\n${JSON.stringify({ mcp_call: { tool, arguments: args } })}\n\`\`\``;
const auto = (...tools: string[]): Partial<Settings> => ({ policies: Object.fromEntries(tools.map((t) => [t, "auto"])) });

let h: Harness;

before(async () => {
  h = await startHarness();
  await h.context.route("https://chat.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: MOCK }));
  writeFileSync(join(h.dir, "a-file.txt"), "content of a file\n");
});
after(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.setSettings({});
  await h.worker.evaluate(() => chrome.storage.local.remove("given"));
  h.calls.length = 0;
});

type MockWindow = { __sent: string[]; __newChat(): void; __openOld(m: { role: string; text: string }[]): void };
interface Mock {
  page: Page;
  logs: string[];
}

interface ChatOptions {
  initial?: { role: string; text: string }[];
  stepMs?: number;
  steps?: number;
  /** Code blocks appear only a moment after the reply is finished (after the stop button went). */
  blocksAtEnd?: boolean;
}

async function withChat(replies: string[], fn: (m: Mock) => Promise<void>, opts: ChatOptions = {}): Promise<void> {
  const page = await h.context.newPage();
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().startsWith("[gmb]")) logs.push(msg.text());
  });
  try {
    await page.addInitScript(
      ([r, i, ms, n, end]) => {
        localStorage.setItem("gmb-debug", "1");
        Object.assign(window, { __replies: r, __initial: i, __stepMs: ms, __steps: n, __blocksAtEnd: end });
      },
      [replies, opts.initial ?? [], opts.stepMs ?? 150, opts.steps ?? 4, opts.blocksAtEnd ?? false] as const,
    );
    await page.goto("https://chat.example.test/");
    assert.equal(await h.toggle(page), true);
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
    await fn({ page, logs });
  } finally {
    await page.close();
  }
}

async function waitLog(m: Mock, pattern: RegExp, times = 1, timeout = 20_000): Promise<void> {
  const end = Date.now() + timeout;
  while (m.logs.filter((l) => pattern.test(l)).length < times) {
    if (Date.now() > end) throw new Error(`no log ${pattern} x${times}; got:\n${m.logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator("textarea").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__sent);
const waitSent = (page: Page, n: number) => page.waitForFunction((k) => (window as unknown as MockWindow).__sent.length >= k, n, { timeout: 20_000 });
const cardButton = (page: Page, label: string) => page.locator("gmb-card").last().getByRole("button", { name: label, exact: true }).click({ timeout: 15_000 });

describe("generic mode", () => {
  it("says so in its panel", () =>
    withChat([], async ({ page }) => {
      await page.locator("gmb-status .pill").click();
      await page.locator("gmb-status").getByText("Generic mode").waitFor();
    }));

  it("copies the page's structure through shadow roots, closed ones too", () =>
    withChat([], async ({ page }) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://chat.example.test" });
      await page.locator("gmb-status .pill").click();
      await page.locator("gmb-status").getByRole("button", { name: "Copy page structure" }).click();
      await page.locator("gmb-status").getByRole("button", { name: "✓ Copied" }).waitFor();
      const text = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(text, /chat-app\n\s+#shadow-root\n/);
      assert.match(text, /textarea \[aria-label="Message"\]/);
      assert.match(text, /icon-button \[aria-label="Send"\]\n\s+#shadow-root \(closed\)\n\s+button\n\s+span\.icon \(text 4\)/);
    }));

  it("adds the instructions, runs the call on Run, sends the results, and stops at the answer", () =>
    withChat([call("list_directory", { path: h.dir }), "There is a-file.txt."], async (m) => {
      await say(m.page, "What is in my folder?");
      await waitSent(m.page, 1);
      const [first] = await sent(m.page);
      assert.ok(first.startsWith(MARK.instructions), first.slice(0, 80));
      assert.ok(first.endsWith("What is in my folder?"));
      await cardButton(m.page, "Run");
      await waitSent(m.page, 2);
      const second = (await sent(m.page))[1];
      assert.ok(second.startsWith(`${MARK.results}\n#1 list_directory → ok`), second.slice(0, 80));
      assert.match(second, /\[FILE\] a-file\.txt/);
      // the example in the instructions (a code block in the user's message) is not a call
      assert.doesNotMatch(second, /#2/);
      await waitLog(m, /answer without calls/);
      assert.equal((await sent(m.page)).length, 2);
      assert.deepEqual(h.calls, ["list_directory"]);
    }));

  it("sends with the page's send button too", () =>
    withChat(["Hello."], async ({ page }) => {
      await page.locator("textarea").click();
      await page.keyboard.type("by button");
      await page.locator("icon-button").click();
      await waitSent(page, 1);
      const [first] = await sent(page);
      assert.ok(first.startsWith(MARK.instructions) && first.endsWith("by button"));
    }));

  it("sends the instructions once per conversation, and again in a new chat at the same address", () =>
    withChat(["Hello.", "Hi.", "Hey."], async (m) => {
      await say(m.page, "first");
      await waitLog(m, /answer without calls/);
      await say(m.page, "second");
      await waitLog(m, /answer without calls/, 2);
      await m.page.evaluate(() => (window as unknown as MockWindow).__newChat());
      await say(m.page, "third");
      await waitSent(m.page, 3);
      const s = await sent(m.page);
      assert.ok(s[0].startsWith(MARK.instructions));
      assert.equal(s[1], "second");
      assert.ok(s[2].startsWith(MARK.instructions), s[2].slice(0, 60));
    }));

  it("never runs the calls already on the page, also when the page draws them anew", async () => {
    await h.setSettings(auto("run_command"));
    const old = call("run_command", { command: "echo old" });
    await withChat(
      ["Hi."],
      async (m) => {
        await say(m.page, "hello");
        await waitLog(m, /answer without calls/);
        await m.page.waitForTimeout(500);
        assert.deepEqual(h.calls, []);
        assert.equal((await sent(m.page)).length, 1);
      },
      { initial: [{ role: "user", text: "old question" }, { role: "model", text: old }] },
    );
  });

  it("runs a call that repeats one from before", async () => {
    await h.setSettings(auto("run_command"));
    const again = call("run_command", { command: "echo again" });
    await withChat(
      [again, "Done."],
      async ({ page }) => {
        await say(page, "once more");
        await waitSent(page, 2);
        assert.match((await sent(page))[1], /#1 run_command → ok[\s\S]*again/);
        assert.deepEqual(h.calls, ["run_command"]);
      },
      { initial: [{ role: "user", text: "old question" }, { role: "model", text: again }] },
    );
  });

  it("waits while the page still writes, even through long pauses", async () => {
    await h.setSettings(auto("run_command"));
    // the block stays cut off (not valid JSON) for longer than a finished reply has to stay unchanged
    await withChat(
      [call("run_command", { command: "echo slow" }), "Done."],
      async (m) => {
        await say(m.page, "slowly");
        await waitSent(m.page, 2);
        const second = (await sent(m.page))[1];
        assert.match(second, /^\[MCP Bridge · results\]\n#1 run_command → ok/);
        assert.doesNotMatch(second, /mcp_call → error/);
        assert.deepEqual(h.calls, ["run_command"]);
      },
      { steps: 3, stepMs: 2600 },
    );
  });

  it("sees a call block that the page draws only as the reply finishes", async () => {
    await h.setSettings(auto("run_command"));
    await withChat(
      [call("run_command", { command: "echo at-the-end" }), "Done."],
      async ({ page }) => {
        await say(page, "at the end");
        await waitSent(page, 2);
        assert.match((await sent(page))[1], /#1 run_command → ok[\s\S]*at-the-end/);
      },
      { steps: 4, stepMs: 800, blocksAtEnd: true },
    );
  });

  it("does not run the calls of an old chat opened while waiting", async () => {
    await h.setSettings(auto("run_command"));
    await withChat(
      ["Hi."],
      async ({ page }) => {
        await say(page, "hello");
        await waitSent(page, 1);
        await page.evaluate(() =>
          (window as unknown as MockWindow).__openOld([
            { role: "user", text: "old question" },
            { role: "model", text: "```json\n" + '{"mcp_call": {"tool": "run_command", "arguments": {"command": "echo old-chat"}}}' + "\n```" },
          ]),
        );
        await page.waitForTimeout(3000);
        assert.deepEqual(h.calls, []);
        assert.equal((await sent(page)).length, 1);
      },
      { stepMs: 1500 },
    );
  });

  it("lets the user drag its button off what it covers, and keeps the place for the site", () =>
    withChat([], async ({ page }) => {
      const pill = page.locator("gmb-status .pill");
      const box = await pill.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 300, box.y - 400, { steps: 5 });
      await page.mouse.up();
      const moved = await pill.boundingBox();
      assert.ok(moved && Math.abs(moved.x - (box.x - 300 - box.width / 2)) < 3 && moved.y < box.y - 350, JSON.stringify(moved));
      // the drag did not open the panel; a click does
      assert.equal(await page.locator("gmb-status").getByRole("button", { name: "Settings" }).count(), 0);
      await pill.click();
      await page.locator("gmb-status").getByRole("button", { name: "Settings" }).waitFor();
      await page.reload();
      await page.locator("gmb-status .pill").waitFor({ timeout: 10_000 });
      const after = await page.locator("gmb-status .pill").boundingBox();
      assert.ok(after && Math.abs(after.x - moved.x) < 3 && Math.abs(after.y - moved.y) < 3, JSON.stringify(after));
    }));

  it("does nothing for a reply the user stopped", async () => {
    await h.setSettings(auto("run_command"));
    await withChat(
      [call("run_command", { command: "echo stopped" })],
      async ({ page }) => {
        await say(page, "go");
        await waitSent(page, 1);
        await page.waitForTimeout(400);
        await page.locator("icon-button").click();
        await page.waitForTimeout(3000);
        assert.deepEqual(h.calls, []);
      },
      { steps: 2, stepMs: 300 },
    );
  });
});
