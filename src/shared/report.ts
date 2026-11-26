// Every problem of the extension goes to the console as an error, with the extension's name in front: in the
// DevTools console of the chat page (the page script), of the service worker (chrome://extensions, also under
// "Errors" there), or of the options page.

const said = new Set<string>();

/** A problem: always in the console, as an error. */
export function problem(what: string, ...details: unknown[]): void {
  console.error(`[MCP Bridge] ${what}`, ...details);
}

/** A problem that may come up again and again (on each frame, each tick): in the console once per text. */
export function problemOnce(what: string, ...details: unknown[]): void {
  if (said.has(what)) return;
  if (said.size >= 500) said.clear();
  said.add(what);
  problem(what, ...details);
}

/** For a promise's catch: the problem with what went wrong. */
export const failed =
  (what: string) =>
  (e: unknown): void =>
    problem(what, e);
