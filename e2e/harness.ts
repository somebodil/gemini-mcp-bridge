// Starts a test MCP server and a Chromium with the built extension, and sets the extension's settings.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Worker } from "playwright";
import type { Settings } from "../src/shared/config.ts";
import { DEFAULT_SETTINGS } from "../src/shared/config.ts";
import { startTestServer } from "./test-server.ts";

export const EXTENSION = resolve(import.meta.dirname, "..", "dist", "extension");
export const TOKEN = "e2e-token-0123456789abcdef";

export interface Harness {
  context: BrowserContext;
  /** The extension's service worker as it is now (a reload of the extension starts a new one). */
  readonly worker: Worker;
  url: string;
  dir: string;
  /** Tools the test server ran, in order. */
  calls: string[];
  setSettings(s: Partial<Settings>): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(opts: { headless?: boolean; locale?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "gmb-e2e-"));
  const server = await startTestServer({ token: TOKEN });
  const url = server.url;
  const profile = mkdtempSync(join(tmpdir(), "gmb-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: opts.headless ?? process.env.HEADED !== "1",
    viewport: { width: 1280, height: 900 },
    locale: opts.locale ?? "en-US",
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, `--lang=${opts.locale ?? "en-US"}`],
  });
  const first = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const current = () => context.serviceWorkers().at(-1) ?? first;
  // the options page opens by itself after the install
  for (const p of context.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();
  context.on("page", (p) => {
    if (p.url().startsWith("chrome-extension://") && p.url().endsWith("options.html")) void p.close();
  });
  const setSettings = async (s: Partial<Settings>) => {
    const settings: Settings = { ...DEFAULT_SETTINGS, servers: [{ id: "local", name: "local", url, token: TOKEN, enabled: true }], ...s };
    await current().evaluate((v) => chrome.storage.local.set({ settings: v }), settings);
  };
  await setSettings({});
  return {
    context,
    get worker() {
      return current();
    },
    url,
    dir,
    calls: server.calls,
    setSettings,
    async close() {
      await context.close();
      server.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
