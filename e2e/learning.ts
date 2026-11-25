// Steps of learning a page in generic mode, against the mock chat page (mock-chat.html), for the tests.

import type { Page } from "playwright";

export const button = (page: Page, text: string) => page.locator("gmb-status button", { hasText: text });
export const box = (page: Page) => page.locator("gmb-status .learn");

export async function startLearning(page: Page): Promise<void> {
  await page.locator("gmb-status .pill").click();
  await button(page, "Learn this page").click();
  await box(page).waitFor();
}

/** Clicks the input box (the test message goes in), sends it, and waits until everything was seen. */
export async function sendTest(page: Page, how: "click" | "enter" = "click"): Promise<void> {
  await page.locator("chat-app textarea").click();
  await page.waitForFunction(() => document.querySelector("chat-app")?.shadowRoot?.querySelector("textarea")?.value.includes("gmb_test"));
  if (how === "click") await page.locator("chat-app icon-button").click();
  else await page.locator("chat-app textarea").press("Enter");
  await box(page).filter({ hasText: "Everything seen" }).waitFor({ timeout: 20_000 });
}

/** The whole learning, up to the list of what was learned. */
export async function learn(page: Page, how: "click" | "enter" = "click"): Promise<void> {
  await startLearning(page);
  await sendTest(page, how);
  await button(page, "Stop learning").click();
  await box(page).filter({ hasText: "What the extension learned" }).waitFor();
}

/** Closes the list of what was learned (and the outlines). */
export async function closeResults(page: Page): Promise<void> {
  await button(page, "Close").click();
  await box(page).waitFor({ state: "detached" });
}
