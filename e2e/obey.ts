// How often Gemini follows the instructions: sends them with a question to the real gemini.google.com (signed
// out), with each model of the picker, and counts the first replies that are a request. Run it after changing
// the wording in src/shared/protocol.ts:
//   MODELS="Auto,4 Hydrogen,4 Neon,4 Carbon" RUNS=3 node e2e/obey.ts
// The model names are those of the picker (signed out, 2026-11). Q sets another question.
import { chromium } from "playwright";
import { buildInstructions } from "../src/shared/protocol.ts";
import { TOOLS } from "./test-server.ts";

const models = (process.env.MODELS ?? "4 Neon,4 Carbon").split(",");
const runs = Number(process.env.RUNS ?? 2);
const notes = ["Computer: macOS 27.2 (arm64).", "Home folder: /Users/me. Relative paths in the tools start there; ~ works too.", "run_command uses /bin/bash."];
const question = process.env.Q ?? "What is the magic word in the .txt file in the folder /Users/me/notes on my computer?";
const text = `${buildInstructions(TOOLS, notes)}\n\n${question}`;
const b = await chromium.launch({ channel: "chromium" });
for (const model of models) {
  let ok = 0;
  for (let i = 0; i < runs; i++) {
    const p = await b.newPage({ locale: "en-US" });
    await p.goto("https://gemini.google.com/app");
    const ed = p.locator("rich-textarea .ql-editor");
    await ed.waitFor({ timeout: 30000 });
    if (model !== "Auto") {
      await p.getByRole("button", { name: /mode picker/i }).click();
      await p.getByText(model, { exact: true }).click();
    }
    await p.waitForTimeout(500);
    await ed.click();
    await p.evaluate((t) => document.execCommand("insertText", false, t), text);
    await p.waitForTimeout(400);
    await p.locator(".send-button button").click();
    let reply = "";
    try {
      await p.waitForFunction(() => { const r = document.querySelector("model-response"); return !!r && !document.querySelector(".send-button.stop") && (r as HTMLElement).innerText.length > 20; }, null, { timeout: 120000, polling: 1000 });
      await p.waitForTimeout(1500);
      reply = await p.locator("model-response").first().innerText();
    } catch { reply = "(no reply)"; }
    const call = /"mcp_call"\s*:/.test(reply);
    if (call) ok++;
    console.log(model, call ? "CALL" : "NO  ", reply.replace(/\s+/g, " ").slice(0, 150));
    await p.close();
  }
  console.log(`== ${model}: ${ok}/${runs}`);
}
await b.close();
