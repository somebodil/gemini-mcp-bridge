// Building elements without HTML strings, for the page of Gemini and the extension's own pages.

type Child = Node | string | null | undefined | false;

declare const __GMB_TEST__: boolean | undefined;

/** Built for the end-to-end tests (scripts/build.mjs --test); never a release. */
export const TEST_BUILD = typeof __GMB_TEST__ !== "undefined" && __GMB_TEST__;

/**
 * The extension's elements on a page keep their insides in a closed shadow root: a script of the page cannot read
 * or change a card (make one tool look like another) or put the focus on its Run button. Open in the tests' build.
 */
export const SHADOW_MODE: ShadowRootMode = TEST_BUILD ? "open" : "closed";

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

/**
 * Only a real click counts: a script of the page could call .click() on a button in an open shadow root, and its
 * events have isTrusted false.
 */
export function onTrustedClick(el: HTMLElement, fn: () => void): void {
  el.addEventListener("click", (e) => {
    if (e.isTrusted) fn();
  });
}
