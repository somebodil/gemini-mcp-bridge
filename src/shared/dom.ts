// Building elements without HTML strings, for the page of Gemini and the extension's own pages.

type Child = Node | string | null | undefined | false;

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
