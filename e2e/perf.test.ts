// The performance log (an option): a slow click and a long frame are written down with the extension's share,
// with a summary of the extension's time; the lines show on the options page, go to local-mcp-bridge-server (by
// either of its names) and to no other server, carry no text of the page, and nothing is measured or kept while
// the option is off.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { Page } from "playwright";
import { startHarness, type Harness } from "./harness.ts";

const SITE = "https://perf.example.test";
const PAGE = `<!doctype html><html><body>
<p>SECRET-TEXT-OF-THE-PAGE</p>
<button id="b" class="slow">Slow</button>
<script>
  document.getElementById("b").addEventListener("click", () => {
    const t = performance.now();
    while (performance.now() - t < 300) {}
    document.body.style.background = document.body.style.background ? "" : "#eee";
  });
</script>
</body></html>`;

const harnesses: Harness[] = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function setUp(serverName?: string): Promise<{ h: Harness; page: Page }> {
  const h = await startHarness({ serverName });
  harnesses.push(h);
  await h.context.route(`${SITE}/**`, (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  await h.setSettings({ perfLog: true });
  const page = await h.context.newPage();
  await page.goto(`${SITE}/`);
  assert.equal(await h.toggle(page), true);
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("tools"), null, { timeout: 10_000 });
  return { h, page };
}

const stored = (h: Harness) => h.worker.evaluate(async () => ((await chrome.storage.session.get("perfLines")).perfLines as string[] | undefined) ?? []);

async function waitLine(h: Harness, re: RegExp, timeout = 15_000): Promise<string> {
  const until = Date.now() + timeout;
  for (;;) {
    const hit = (await stored(h)).find((l) => re.test(l));
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`no line like ${re} in:\n${(await stored(h)).join("\n")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("performance log", () => {
  it("writes down a slow click, a long frame and the extension's time; shows them; the server gets them", async () => {
    const { h, page } = await setUp("local-mcp-bridge-server");
    await page.click("#b");
    const click = await waitLine(h, /slow click/);
    assert.match(click, /^\d\d:\d\d:\d\d slow click (\d+) ms \(wait \d+, handlers (\d+), paint \d+\) on button\.slow · extension \d+ ms/);
    assert.ok(Number(/handlers (\d+)/.exec(click)?.[1]) >= 280, click);
    assert.match(await waitLine(h, /long frame/), /long frame \d+ ms \(blocking \d+/);
    assert.match(await waitLine(h, /: extension \d+ ms/), /last \d+ s: extension \d+ ms \(\d+\.\d %\) · .*tick ×\d+ .*\| page: 1 slow interactions \(worst \d+ ms\)/);
    const all = await stored(h);
    assert.match(all[0], /^--- \d{4}-\d\d-\d\d \d\d:\d\d:\d\d https:\/\/perf\.example\.test · extension [\d.]+, generic mode · Chrome \d+ · writes down/);
    assert.ok(!all.some((l) => l.includes("SECRET") || l.includes("Slow")), "no text of the page");
    assert.ok(h.perf.some((l) => l.includes("slow click")), "the server got the lines");

    // the options page shows them, and where the server writes them
    const options = await h.context.newPage();
    await options.goto(new URL("options.html", h.worker.url()).href);
    const box = options.locator("textarea.perf");
    await options.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea.perf")?.value.includes("slow click"));
    await options.getByText("local-mcp-bridge-server writes them to /home/test/.config/local-mcp-bridge-server/perf.log too.").waitFor();
    await options.getByRole("button", { name: "Clear" }).click();
    await options.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea.perf")?.value === "");
    assert.equal(await box.inputValue(), "");

    // off: nothing is measured or kept
    await options.getByRole("checkbox", { name: "Write the performance log" }).uncheck();
    await page.waitForTimeout(1500);
    const before = h.perf.length;
    await page.click("#b");
    await page.waitForTimeout(4000);
    assert.deepEqual(await stored(h), []);
    assert.equal(h.perf.length, before);
    await options.close();
    await page.close();
  });

  it("sends them to the server of the former name too, gemini-mcp-bridge-server (until its 0.6.0)", async () => {
    const { h, page } = await setUp("gemini-mcp-bridge-server");
    await page.click("#b");
    await waitLine(h, /slow click/);
    const until = Date.now() + 15_000;
    while (!h.perf.some((l) => l.includes("slow click"))) {
      if (Date.now() > until) throw new Error(`the server got no slow click: ${h.perf.join("\n")}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    await page.close();
  });

  it("keeps the lines in the browser only when the server is another one", async () => {
    const { h, page } = await setUp();
    await page.click("#b");
    await waitLine(h, /slow click/);
    assert.deepEqual(h.perf, []);
    const server = await h.worker.evaluate(async () => (await chrome.storage.session.get("perfServer")).perfServer);
    assert.deepEqual(server, { ok: false, why: "none" });
    await page.close();
  });
});
