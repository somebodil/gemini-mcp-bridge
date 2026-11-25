// Makes the Chrome Web Store screenshots (1280×800) from a real session on gemini.google.com, signed out, and
// the small promo tile (440×280). Run after `npm run build`: node store/shots.ts

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarness } from "../e2e/harness.ts";

const OUT = join(import.meta.dirname, "images");
mkdirSync(OUT, { recursive: true });

// a short folder name for the pictures (the harness's own temporary folder has a long random path)
const DEMO = "/tmp/gemini-demo";
rmSync(DEMO, { recursive: true, force: true });
mkdirSync(DEMO);
const h = await startHarness({ locale: "en-US" });
try {
  writeFileSync(join(DEMO, "todo.md"), "# Today\n- Renew the passport (expires March 3)\n- Send the slides to Mina\n- Book the dentist\n");
  writeFileSync(join(DEMO, "notes.txt"), "Project kickoff on Monday.\n");
  await h.setSettings({ policies: { list_directory: "auto" } });
  const page = await h.context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("https://gemini.google.com/app");
  const editor = page.locator("rich-textarea .ql-editor");
  await editor.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("gmb-status")?.shadowRoot?.textContent?.includes("4 tools"), null, { timeout: 15_000 });
  await editor.click();
  await page.keyboard.type(`What's on my to-do list? It's a file in ${DEMO}`);
  await page.keyboard.press("Enter");

  // read_file asks: the card with its buttons
  const run = page.locator("gmb-card").last().getByRole("button", { name: "Run", exact: true });
  await run.waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  await page.locator("gmb-card").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, "screenshot-1-ask.png") });
  await run.click();

  await page.waitForFunction(() => [...document.querySelectorAll("model-response")].some((r) => /passport/i.test((r as HTMLElement).innerText) && !r.querySelector("code-block")), null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, "screenshot-2-answer.png") });

  const id = new URL(h.worker.url()).host;
  const options = await h.context.newPage();
  await options.setViewportSize({ width: 1280, height: 800 });
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForTimeout(1500);
  await options.screenshot({ path: join(OUT, "screenshot-3-options.png") });

  const icon = `data:image/png;base64,${readFileSync(join(import.meta.dirname, "..", "static", "icons", "128.png")).toString("base64")}`;
  const tile = await h.context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.setContent(`<body style="margin:0;width:440px;height:280px;display:flex;align-items:center;justify-content:center;gap:20px;
    background:linear-gradient(135deg,#0b57d0,#4c8df6);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff">
    <img src="${icon}" width="96" height="96" style="border-radius:22px;box-shadow:0 4px 16px rgba(0,0,0,.25)">
    <div><div style="font-size:30px;font-weight:700;line-height:1.1">Gemini<br>MCP Bridge</div>
    <div style="font-size:15px;margin-top:10px;opacity:.95">Your computer's tools<br>for Gemini on the web</div></div></body>`);
  await tile.waitForTimeout(500);
  await tile.screenshot({ path: join(OUT, "promo-small.png") });
  console.log(`images: ${OUT}`);
} finally {
  await h.close();
  rmSync(DEMO, { recursive: true, force: true });
}
