// The extension in Chromium against a page that copies the parts of gemini.google.com it relies on, with
// scripted replies: deterministic, no Google account, no network. Clicks are real input events (Playwright),
// as the extension ignores clicks made by scripts. Waits follow the extension's own debug log ("reply finished",
// "results sent") rather than fixed sleeps; a test that checks that nothing happens waits for the moment it
// would have happened.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Page } from "playwright";
import type { Settings } from "../src/shared/config.ts";
import { MARK } from "../src/shared/protocol.ts";
import { auto, startHarness, TOKEN, type Harness } from "./harness.ts";
import { startTestServer } from "./test-server.ts";

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
  // every mock chat gets the same address: what one test sent must not count for the next
  await h.worker.evaluate(() => chrome.storage.local.remove("given"));
  h.calls.length = 0;
});

type MockWindow = { __replies: string[]; __initial: string[]; __sent: string[]; __delay?: number; __openOld(m: ({ user: string } | { model: string })[]): void };
interface Mock {
  page: Page;
  logs: string[];
  /** The problems the extension wrote to the page's console. */
  errors: string[];
}

/** Opens the mock page with scripted replies, runs `fn`, and closes the page even when `fn` fails. */
async function withMock(replies: string[], fn: (m: Mock) => Promise<void>, opts: { initial?: string[]; delay?: number } = {}): Promise<void> {
  const page = await h.context.newPage();
  const logs: string[] = [];
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().startsWith("[gmb]")) logs.push(msg.text());
    // as errors only: anything else shows its type in front and fails the checks
    if (msg.text().startsWith("[MCP Bridge]")) errors.push(msg.type() === "error" ? msg.text() : `(${msg.type()}) ${msg.text()}`);
  });
  try {
    await page.addInitScript(
      ([r, i, d]) => {
        localStorage.setItem("gmb-debug", "1");
        const w = window as unknown as MockWindow;
        w.__replies = r;
        w.__initial = i;
        w.__delay = d;
      },
      [replies, opts.initial ?? [], opts.delay ?? 500] as const,
    );
    await page.goto("https://gemini.google.com/app");
    assert.equal(await h.toggle(page), true);
    await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
    await fn({ page, logs, errors });
  } finally {
    await page.close();
  }
}

/** Waits until the extension logged `pattern` `times` times. */
async function waitLog(m: Mock, pattern: RegExp, times = 1, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (m.logs.filter((l) => pattern.test(l)).length < times) {
    if (Date.now() > end) throw new Error(`no log ${pattern} x${times}; got:\n${m.logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
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
const editorText = (page: Page) => page.locator("rich-textarea .ql-editor").innerText();

describe("with a mock Gemini", () => {
  it("adds the instructions, asks, runs on Run, sends the results, and stops at the answer", () =>
    withMock([call("list_directory", { path: h.dir }), "There is a-file.txt."], async (m) => {
      const { page } = m;
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
      // the answer has no call: the extension reads it and sends nothing
      await waitLog(m, /reply finished/, 2);
      await waitLog(m, /calls \[\] \[\]/);
      // nothing went wrong: nothing in the console
      assert.deepEqual(m.errors, []);
      assert.equal((await sent(page)).length, 2);
      assert.match((await cardTexts(page))[0], /list_directory.*Done/);
      const chips = await page.locator(".gmb-chip").allInnerTexts();
      assert.deepEqual(chips, ["🔧 MCP Bridge instructions · 4 tools", "🔧 Tool results: list_directory ✓"]);
      const visible = await page.locator("user-query").first().locator(".query-text-line:visible").allInnerTexts();
      assert.deepEqual(
        visible.filter((x) => x.trim()),
        ["What is in my folder?"],
      );
    }));


  it("follows each exchange in the status line", async () => {
    await h.setSettings(auto("list_directory"));
    await withMock([call("list_directory", { path: h.dir }), "There is a-file.txt."], async ({ page }) => {
      const status = page.locator("gmb-status .flow");
      await say(page, "What is in my folder?");
      await status.filter({ hasText: "Sent with the tool instructions" }).waitFor();
      await status.filter({ hasText: "Sent with the tool results" }).waitFor({ timeout: 20_000 });
      await status.filter({ hasText: "Done: the reply has no call" }).waitFor({ timeout: 20_000 });
      await status.waitFor({ state: "detached", timeout: 10_000 });
      assert.deepEqual(h.calls, ["list_directory"]);
    });
  });
  it("sends the instructions once per conversation", () =>
    withMock(["Hello.", "Hi again."], async (m) => {
      await say(m.page, "first");
      await waitLog(m, /reply finished/);
      await say(m.page, "second");
      await waitSent(m.page, 2);
      const s = await sent(m.page);
      assert.ok(s[0].startsWith(MARK.instructions));
      assert.equal(s[1], "second");
    }));

  it("sends a refusal when the user denies", () =>
    withMock([call("run_command", { command: "echo hi" }), "OK."], async ({ page }) => {
      await say(page, "run something");
      await cardButton(page, "Deny");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /#1 run_command → error\n```text\nThe user declined this call\./);
      assert.deepEqual(h.calls, []);
    }));

  it("remembers Always allow, for this site", () =>
    withMock([call("run_command", { command: "echo always" }), "Done."], async ({ page }) => {
      await say(page, "run it");
      await cardButton(page, "Always allow here");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /exit code: 0\n--- stdout ---\nalways/);
      const s = await h.worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings as Settings);
      assert.equal(s.policies.run_command, "auto");
      assert.deepEqual(s.autoSites, ["https://gemini\\.google\\.com"], "Gemini was in the list already");
    }));

  it("runs auto tools without asking, several calls in order", async () => {
    await h.setSettings(auto("read_file", "list_directory"));
    const two = `${call("list_directory", { path: h.dir })}\n${call("read_file", { path: join(h.dir, "a-file.txt") })}`;
    await withMock([two, "Done."], async ({ page, errors }) => {
      await say(page, "look");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /#1 list_directory → ok[\s\S]*#2 read_file → ok\n```text\ncontent of a file/);
      assert.deepEqual(errors, []);
    });
  });

  it("answers an unreadable call with an error that Gemini can act on, and shows why on the card", () =>
    withMock(['```json\n{"mcp_call": {"tool": "read_file", "arguments": {"path": }}}\n```', "Sorry."], async ({ page, errors }) => {
      await say(page, "read");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /#1 mcp_call → error\n```text\nThe block is not valid JSON \(.+\)\. In a JSON string, write each backslash as .+\nYou wrote: /);
      assert.match((await cardTexts(page))[0], /mcp_call.*Unreadable call.*The block is not valid JSON \(/);
      assert.match(errors.join("\n"), /^\[MCP Bridge\] A call in the reply could not be read: The block is not valid JSON \(/);
    }));

  it("reports a broken call that holds a {}, instead of waiting without a word", () =>
    withMock(['```json\n{"mcp_call": {"tool": "write_file", "arguments": {"path" "a.js", "content": "const d = {};"}}}\n```', "Sorry."], async ({ page, errors }) => {
      await say(page, "write");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /#1 mcp_call → error\n```text\nThe block is not valid JSON \(/);
      assert.match(errors.join("\n"), /A call in the reply could not be read/);
    }));

  it("writes a file whose content came across lines with bare double quotes and braces", async () => {
    await h.setSettings(auto("write_file"));
    const path = `${h.dir}/bare.js`;
    const code = 'const d = {};\nconsole.log("hi", d);\n';
    const reply = `Writing it.\n\`\`\`json\n{"mcp_call": {"tool": "write_file", "arguments": {"path": ${JSON.stringify(path)}, "content": "${code}"}}}\n\`\`\``;
    await withMock([reply, "Done."], async ({ page, errors }) => {
      await say(page, "write");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /#1 write_file → ok/);
      assert.equal(readFileSync(path, "utf8"), code);
      assert.deepEqual(errors, []);
    });
  });

  it("tells Gemini about a tool that does not exist", () =>
    withMock([call("format_disk", {}), "OK."], async ({ page, errors }) => {
      await say(page, "x");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /There is no tool named "format_disk"\. Available tools: run_command, read_file, write_file, list_directory\./);
      assert.match(errors.join("\n"), /\[MCP Bridge\] format_disk: There is no tool named "format_disk"/);
    }));

  it("runs a call written without a code fence, with its card at the end of the reply", async () => {
    await h.setSettings(auto("list_directory"));
    const bare = `Checking: ${JSON.stringify({ mcp_call: { tool: "list_directory", arguments: { path: h.dir } } })}`;
    await withMock([bare, "Done."], async ({ page }) => {
      await say(page, "list");
      await waitSent(page, 2);
      assert.match((await sent(page))[1], /#1 list_directory → ok/);
      assert.match((await cardTexts(page))[0], /list_directory.*Done/);
    });
  });

  it("runs at most 10 calls of one reply", async () => {
    await h.setSettings(auto("list_directory"));
    const eleven = Array.from({ length: 11 }, () => call("list_directory", { path: h.dir })).join("\n");
    await withMock([eleven, "Done."], async ({ page }) => {
      await say(page, "many");
      await waitSent(page, 2);
      assert.equal(h.calls.length, 10);
      assert.match((await sent(page))[1], /#11 list_directory → error\n```text\nNot run: at most 10 calls per reply\./);
    });
  });

  it("keeps the user's draft, and sends the results with it on a click", async () => {
    await h.setSettings(auto("list_directory"));
    await withMock([call("list_directory", { path: h.dir }), "Done."], async ({ page }) => {
      await say(page, "go");
      await waitSent(page, 1);
      await page.locator("rich-textarea .ql-editor").click();
      await page.keyboard.type("my draft");
      await page.locator("gmb-status").getByRole("button", { name: "Send results" }).click({ timeout: 10_000 });
      await waitSent(page, 2);
      const r = (await sent(page))[1];
      assert.ok(r.startsWith(MARK.results) && r.endsWith("my draft"), r.slice(-40));
    });
  });

  it("puts waiting results in front of the draft when the user sends it", async () => {
    await h.setSettings(auto("list_directory"));
    await withMock([call("list_directory", { path: h.dir }), "Done."], async ({ page }) => {
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
    });
  });

  it("leaves the results in the input box when sending by itself is off", async () => {
    await h.setSettings({ ...auto("list_directory"), autoSend: false });
    await withMock([call("list_directory", { path: h.dir })], async ({ page }) => {
      await say(page, "go");
      await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("in the input box"), null, { timeout: 10_000 });
      assert.equal((await sent(page)).length, 1);
      assert.ok((await editorText(page)).startsWith(MARK.results));
    });
  });

  it("does not tell Gemini about tools that are off, and sends an update when the list changes", async () => {
    await h.setSettings({ policies: { write_file: "off" } });
    await withMock(["Hello.", "Hi."], async (m) => {
      await say(m.page, "first");
      await waitLog(m, /reply finished/);
      const [first] = await sent(m.page);
      assert.doesNotMatch(first, /- write_file:/);
      assert.match(first, /MCP Bridge instructions|tool instructions/);
      await h.setSettings({ policies: { write_file: "off", run_command: "off" } });
      await m.page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("2 tools"), null, { timeout: 10_000 });
      await say(m.page, "second");
      await waitSent(m.page, 2);
      const second = (await sent(m.page))[1];
      assert.ok(second.startsWith(MARK.toolsUpdate), second.slice(0, 60));
      assert.doesNotMatch(second, /- run_command:/);
      assert.ok(second.endsWith("second"));
      await m.page.locator("user-query").last().locator(".gmb-chip").waitFor();
      assert.equal(await m.page.locator("user-query").last().locator(".gmb-chip").innerText(), "🔧 MCP Bridge tool list update");
    });
  });

  it("names tools after their server when two servers share them, and calls the right one", async () => {
    const second = await startTestServer();
    try {
      await h.setSettings({
        servers: [
          { id: "local", name: "local", url: h.url, token: TOKEN, enabled: true },
          { id: "second", name: "second", url: second.url, token: "", enabled: true },
        ],
        policies: { second__list_directory: "auto" },
      });
      await withMock([call("second__list_directory", { path: h.dir }), "Done."], async ({ page }) => {
        await say(page, "list there");
        await waitSent(page, 2);
        assert.match((await sent(page))[0], /- local__list_directory: [\s\S]*- second__list_directory: /);
        assert.match((await sent(page))[1], /#1 second__list_directory → ok/);
        assert.deepEqual(second.calls, ["list_directory"]);
        assert.deepEqual(h.calls, []);
      });
    } finally {
      second.close();
    }
  });
});

describe("approval cannot be skipped", () => {
  it("a script of the page cannot press Run", () =>
    withMock([call("run_command", { command: "echo forged" }), "OK."], async ({ page }) => {
      await say(page, "x");
      const run = lastCard(page).getByRole("button", { name: "Run", exact: true });
      await page.waitForFunction(() => [...(document.querySelector("gmb-card")?.shadowRoot?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Run" && !b.disabled));
      await page.evaluate(() => {
        const b = [...(document.querySelector("gmb-card")?.shadowRoot?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Run");
        (b as HTMLButtonElement).click();
      });
      await page.waitForTimeout(300);
      assert.ok(await run.isVisible(), "still asking");
      assert.deepEqual(h.calls, []);
      assert.equal((await sent(page)).length, 1);
    }));

  it("a click in the first moment after the question does not answer it; one after does", () =>
    withMock([call("run_command", { command: "echo late" }), "OK."], async ({ page }) => {
      await say(page, "x");
      const run = lastCard(page).getByRole("button", { name: "Run", exact: true });
      await run.waitFor();
      const box = await run.boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press("Space");
      await page.waitForTimeout(100);
      assert.deepEqual(h.calls, [], "the early click and key did nothing");
      await page.waitForTimeout(700);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await waitSent(page, 2);
      assert.deepEqual(h.calls, ["run_command"]);
    }));

  it("the service worker refuses an 'ask' tool without approval, whatever the page believes", async () => {
    const id = new URL(h.worker.url()).host;
    const page = await h.context.newPage();
    try {
      await page.goto(`chrome-extension://${id}/options.html`);
      const viaPort = (approved: boolean, tool = "run_command") =>
        page.evaluate(
          ([a, n]) =>
            new Promise<{ ok: boolean; needsApproval?: boolean; text: string }>((resolve) => {
              const port = chrome.runtime.connect({ name: "call" });
              port.onMessage.addListener((r: { ok: boolean; needsApproval?: boolean; text: string }) => resolve(r));
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
      // Auto on Gemini only: this page (the extension's own) is another site
      await h.setSettings({ policies: { run_command: "auto" }, autoSites: ["https://gemini\\.google\\.com"] });
      const elsewhere = await viaPort(false);
      assert.equal(elsewhere.needsApproval, true);
      await h.setSettings({ policies: { run_command: "auto" }, autoSites: [`chrome-extension://${id}`] });
      assert.match((await viaPort(false)).text, /via-port/);
      h.calls.length = 0;
    } finally {
      await page.close();
    }
  });
});

describe("only the answer to a message this tab sent", () => {
  it("never runs the calls of a conversation that was already on the page", async () => {
    await h.setSettings(auto("run_command"));
    await withMock(
      [],
      async ({ page }) => {
        // nothing can be waited for here: two ticks past the time a reply needs to settle
        await page.waitForTimeout(2000);
        assert.equal((await sent(page)).length, 0);
        assert.match((await cardTexts(page))[0], /Earlier call/);
      },
      { initial: [call("run_command", { command: "echo old" })] },
    );
  });

  it("does not run an old reply's call when the user sends a new message", async () => {
    await h.setSettings(auto("run_command"));
    await withMock(
      ["Hi."],
      async (m) => {
        await say(m.page, "hello");
        await waitLog(m, /reply finished/);
        await waitLog(m, /calls \[\] \[\]/);
        assert.deepEqual(h.calls, []);
        assert.equal((await sent(m.page)).length, 1);
      },
      { initial: [call("run_command", { command: "echo old" })], delay: 1500 },
    );
  });

  it("does not run the calls of an old chat opened while waiting in a new one", async () => {
    await h.setSettings(auto("run_command"));
    await withMock(
      ["Hi."],
      async ({ page }) => {
        await say(page, "hello");
        await waitSent(page, 1);
        await page.evaluate(() =>
          (window as unknown as MockWindow).__openOld([{ user: "old question" }, { model: "```json\n" + '{"mcp_call": {"tool": "run_command", "arguments": {"command": "echo old-chat"}}}' + "\n```" }]),
        );
        await page.waitForTimeout(2500);
        assert.deepEqual(h.calls, []);
        assert.equal((await sent(page)).length, 1);
      },
      { delay: 1500 },
    );
  });

  it("does not send the results of one chat into another", async () => {
    await h.setSettings(auto("run_command"));
    await withMock([call("run_command", { command: "sleep 2; echo A-SECRET" })], async ({ page }) => {
      await say(page, "slow");
      await page.waitForFunction(() => [...document.querySelectorAll("gmb-card")].some((c) => c.shadowRoot?.textContent?.includes("Running")), null, { timeout: 10_000 });
      await page.evaluate(() => (window as unknown as MockWindow).__openOld([{ user: "other chat" }, { model: "Other answer." }]));
      await page.waitForTimeout(3000);
      assert.equal((await sent(page)).length, 1, "no results went into the other chat");
    });
  });

  it("does nothing for a reply the user stopped", async () => {
    await h.setSettings(auto("run_command"));
    await withMock(
      [call("run_command", { command: "echo stopped" })],
      async (m) => {
        await say(m.page, "go");
        await waitSent(m.page, 1);
        await m.page.locator(".send-button button").click();
        await waitLog(m, /reply finished/);
        await m.page.waitForTimeout(500);
        assert.deepEqual(h.calls, []);
      },
      { delay: 3000 },
    );
  });

  it("does nothing in a new chat where the user turned it off, also for the reply", async () => {
    await h.setSettings(auto("run_command"));
    await withMock([call("run_command", { command: "echo off" })], async ({ page }) => {
      await page.evaluate(() => sessionStorage.setItem("gmb-off:new", "1"));
      await say(page, "plain message");
      await waitSent(page, 1);
      assert.equal((await sent(page))[0], "plain message");
      await page.waitForTimeout(2000);
      assert.deepEqual(h.calls, []);
      assert.equal((await sent(page)).length, 1);
    });
  });

  it("the status button turns the tools off for the chat", () =>
    withMock(["Hello."], async ({ page }) => {
      const status = page.locator("gmb-status");
      await status.locator(".pill").click();
      await status.getByRole("checkbox").click();
      await say(page, "without tools");
      await waitSent(page, 1);
      assert.equal((await sent(page))[0], "without tools");
    }));
});

describe("rounds and sends", () => {
  it("goes on round after round without pausing", async () => {
    await h.setSettings(auto("list_directory"));
    const loop = call("list_directory", { path: h.dir });
    await withMock([loop, loop, loop, loop, "Done."], async ({ page }) => {
      await say(page, "loop");
      await page.waitForFunction(() => (window as unknown as MockWindow).__sent.length >= 5, null, { timeout: 60_000 });
      assert.equal(h.calls.length, 4, "every reply's call ran, without a Continue");
    });
  });

  it("sends one message when Enter is pressed twice", () =>
    withMock(["Hello."], async (m) => {
      await m.page.locator("rich-textarea .ql-editor").click();
      await m.page.keyboard.type("once");
      await m.page.keyboard.press("Enter");
      await m.page.keyboard.press("Enter");
      await waitLog(m, /reply finished/);
      const s = await sent(m.page);
      assert.equal(s.length, 1);
      assert.equal(s[0].split(MARK.instructions).length - 1, 1);
    }));
});

describe("options page", () => {
  it("adds a server, refuses a remote URL, saves a policy, and shows clamped numbers", async () => {
    const id = new URL(h.worker.url()).host;
    const page = await h.context.newPage();
    try {
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.getByText("Connected · test-server · 4 tools").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Add server" }).click();
      await page.locator(".server").nth(1).waitFor();
      const url = page.locator(".server").nth(1).locator("input.url");
      await url.fill("http://example.com/mcp");
      await url.press("Tab");
      await page.getByText("Only 127.0.0.1 and localhost addresses can be reached.").waitFor();
      await page.getByRole("combobox", { name: "read_file" }).selectOption("auto");
      const chars = page.locator("label", { hasText: "Characters of tool output per message" }).locator("input");
      await chars.fill("999999");
      await chars.press("Tab");
      await page.waitForFunction(() => (document.querySelectorAll("input[type=number]")[0] as HTMLInputElement).value === "200000");
      const saved = await h.worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings as Settings);
      assert.equal(saved.servers.length, 2);
      assert.equal(saved.servers[1].url, "http://127.0.0.1:7341/mcp", "the remote URL was not saved");
      assert.equal(saved.policies.read_file, "auto");
      assert.equal(saved.maxResultChars, 200000);
    } finally {
      await page.close();
    }
  });

  it("the sites of the Auto tools: one list, Gemini's at first, checked line by line, saved only when every line is right", async () => {
    const id = new URL(h.worker.url()).host;
    const page = await h.context.newPage();
    const stored = () => h.worker.evaluate(async () => ((await chrome.storage.local.get("settings")).settings as Settings).autoSites);
    const policy = (tool: string) => page.getByRole("combobox", { name: tool, exact: true });
    try {
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.getByText("Connected · test-server · 4 tools").waitFor({ timeout: 10_000 });
      const box = page.getByRole("textbox", { name: "Sites of the Auto tools" });
      assert.equal(await box.count(), 0, "no box while no tool is Auto");
      await policy("read_file").selectOption("auto");
      assert.equal(await box.inputValue(), "https://gemini\\.google\\.com");
      const check = page.getByRole("button", { name: "Check", exact: true });
      const checks = page.locator(".checks");
      await check.click();
      await checks.getByText("The syntax is right (lines: 1).").waitFor();
      await checks.getByText("https://gemini.google.com: matches line 1.").waitFor();

      // a broken line: said with its number, and nothing is saved
      await box.fill("https://gemini\\.google\\.com\n\nhttps://(chat");
      await check.click();
      await checks.getByText("Line 3: Unterminated group").waitFor();
      await checks.getByText("Not saved: every line has to be right.").waitFor();
      assert.deepEqual(await stored(), ["https://gemini\\.google\\.com"]);

      // written without https://: it matches the host, not the address
      const address = page.getByRole("textbox", { name: "Address to try the patterns on" });
      await address.fill("chat.example.test/c/123");
      await box.fill("chat\\.example\\.test");
      await check.click();
      await checks.getByText("https://chat.example.test: no line matches, so the Auto tools are asked about there.").waitFor();
      await checks.getByText("Line 1 matches chat.example.test but not https://chat.example.test").waitFor();

      // dots written as they are: they match any character
      await box.fill("https://chat.example.test");
      await check.click();
      await checks.getByText("Line 1: a plain . matches any character").waitFor();

      // right: saved when the box is left
      await box.fill("https://gemini\\.google\\.com\nhttps://(chat|www)\\.example\\.test");
      await box.press("Tab");
      await checks.getByText("https://chat.example.test: matches line 2.").waitFor();
      await page.waitForFunction(() => document.getElementById("saved")?.textContent === "Saved");
      const two = ["https://gemini\\.google\\.com", "https://(chat|www)\\.example\\.test"];
      assert.deepEqual(await stored(), two);

      // another Auto tool has the same list, and one leaving Auto does not take it away
      await policy("list_directory").selectOption("auto");
      await policy("read_file").selectOption("ask");
      await page.waitForFunction(() => document.getElementById("saved")?.textContent === "Saved");
      assert.equal(await box.inputValue(), two.join("\n"));
      assert.deepEqual(await stored(), two);

      // what is typed and not saved stays when the tools are repainted (a tool allowed on a chat page meanwhile)
      await box.fill(".*\nhttps://(");
      await h.worker.evaluate(async () => {
        const all = await chrome.storage.local.get("settings");
        const s = all.settings as Settings;
        s.policies.write_file = "auto";
        await chrome.storage.local.set({ settings: s });
      });
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="write_file"]')?.value === "auto");
      assert.equal(await box.inputValue(), ".*\nhttps://(");
      await box.fill(".*");
      await check.click();
      await checks.getByText("Line 1 matches any site.").waitFor();

      // no line: asked about everywhere
      await box.fill("");
      await box.press("Tab");
      await checks.getByText("No site: the Auto tools are asked about everywhere.").waitFor();
      await page.waitForFunction(() => document.getElementById("saved")?.textContent === "Saved");
      assert.deepEqual(await stored(), []);

      // no tool Auto: the box goes, the list stays
      await policy("list_directory").selectOption("ask");
      await policy("write_file").selectOption("ask");
      await box.waitFor({ state: "detached" });
      assert.deepEqual(await stored(), []);
    } finally {
      await page.close();
    }
  });
});

describe("on only in the tabs where the user turned it on", () => {
  const status = (page: Page) => page.evaluate(() => document.querySelector("gmb-status") !== null);

  it("is not in a tab until it is turned on there, and not in the other tabs", async () => {
    const other = await h.context.newPage();
    try {
      // another address: the tests find a tab by its address
      await other.goto("https://gemini.google.com/app?other");
      await withMock(["Hello."], async () => {
        await other.waitForTimeout(1000);
        assert.equal(await status(other), false);
      });
    } finally {
      await other.close();
    }
  });

  it("turns off and on again with the icon; off, messages go as written", () =>
    withMock(["Hello.", "Hi."], async (m) => {
      assert.equal(await h.toggle(m.page), false);
      await m.page.waitForFunction(() => document.querySelector("gmb-status") === null);
      await say(m.page, "while off");
      await waitSent(m.page, 1);
      assert.equal((await sent(m.page))[0], "while off");
      assert.equal(await h.toggle(m.page), true);
      await m.page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"));
      await say(m.page, "on again");
      await waitSent(m.page, 2);
      assert.ok((await sent(m.page))[1].startsWith(MARK.instructions));
    }));

  it("turns off from its panel", () =>
    withMock(["Hello."], async ({ page }) => {
      await page.locator("gmb-status .pill").click();
      await page.locator("gmb-status").getByRole("button", { name: "Turn off in this tab" }).click();
      await page.waitForFunction(() => document.querySelector("gmb-status") === null);
      const on = await h.worker.evaluate(async () => (await chrome.storage.session.get("activeTabs")).activeTabs as Record<string, string>);
      assert.deepEqual(Object.values(on), []);
    }));

  it("stays on when the page is reloaded", () =>
    withMock(["Hello."], async ({ page }) => {
      await page.reload();
      await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
      await say(page, "after reload");
      await waitSent(page, 1);
      assert.ok((await sent(page))[0].startsWith(MARK.instructions));
    }));

  it("copies the page's structure without its text", () =>
    withMock(["Hello."], async (m) => {
      await m.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://gemini.google.com" });
      await say(m.page, "a private question");
      await waitLog(m, /reply finished/);
      await m.page.locator("gmb-status .pill").click();
      await m.page.locator("gmb-status").getByRole("button", { name: "Copy page structure" }).click();
      await m.page.locator("gmb-status").getByRole("button", { name: "✓ Copied" }).waitFor();
      const text = await m.page.evaluate(() => navigator.clipboard.readText());
      assert.match(text, /^https:\/\/gemini\.google\.com\/app/);
      assert.match(text, /rich-textarea\n\s+div\.ql-editor[^\n]*\[contenteditable="true"\]/);
      assert.match(text, /user-query/);
      assert.doesNotMatch(text, /private question|Hello|gmb-status|gmb-card/);
    }));
});

// last: it reloads the extension
describe("after the extension is updated", () => {
  it("leaves the open tabs, and lets Enter through", () =>
    withMock(["Hello."], async ({ page }) => {
      await h.worker.evaluate(() => chrome.runtime.reload());
      await h.context.waitForEvent("serviceworker", { timeout: 10_000 }).catch(() => undefined);
      await say(page, "after the update");
      await waitSent(page, 1);
      assert.equal((await sent(page))[0], "after the update", "sent as written, without instructions");
      await page.waitForFunction(() => document.querySelector("gmb-status") === null, null, { timeout: 5000 });
    }));
});
