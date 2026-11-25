// The options page: servers, tool policies, behavior, and the chat pages that were learned. Every change is saved
// at once, into the settings as they are stored then: "Always allow" on Gemini's page may have changed others
// meanwhile.

import { DEFAULT_URL, isLocalUrl, loadSettings, updateSettings, type BridgeState, type Policy, type Request, type ServerConfig, type Settings } from "../shared/config.ts";
import { h } from "../shared/dom.ts";
import { t, type Key } from "../shared/i18n.ts";
import { LAYOUTS_KEY, loadLayouts, ROLES, storeLayout, type Role } from "../shared/layouts.ts";
import { allowedOn, GEMINI_SITE, originOf, own, readSites } from "../shared/sites.ts";

let settings: Settings;
let state: BridgeState | undefined;
const app = document.getElementById("app") as HTMLElement;
/** Repaints the status line of each server once the service worker answered. */
const painters: (() => void)[] = [];
/** Per tool: what is typed in its box of sites and not saved yet, and what its last check said. They outlive a
 * repaint of the table (a tool allowed on a chat page meanwhile). */
const drafts = new Map<string, string>();
const checks = new Map<string, { text: string; bad?: boolean }[]>();
const GEMINI = "https://gemini.google.com";
let tryAddress = GEMINI;

async function update(change: (s: Settings) => void): Promise<void> {
  const before = JSON.stringify(settings);
  let others = false;
  settings = await updateSettings((fresh) => {
    // changed elsewhere meanwhile ("Always allow" on a chat page): the change event of that may come too late
    others = JSON.stringify(fresh) !== before;
    change(fresh);
  });
  if (others) renderTools();
  const s = document.getElementById("saved");
  if (s) {
    s.textContent = t("optSaved");
    setTimeout(() => (s.textContent = ""), 1200);
  }
}

async function loadState(refresh: boolean): Promise<void> {
  const got = await chrome.runtime.sendMessage<Request, (BridgeState & { error?: string }) | undefined>({ type: "getState", refresh }).catch(() => undefined);
  state = got && !got.error ? got : undefined;
  for (const paint of painters) paint();
  renderTools();
}

function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const c = h("input", { type: "checkbox" });
  c.checked = checked;
  c.addEventListener("change", () => onChange(c.checked));
  return c;
}

/** One behavior setting: a switch or a number, saved on change; a number shows the value it was saved as. */
function settingRow(key: "autoSend" | "maxRounds" | "maxResultChars" | "callTimeoutSec", label: string): HTMLElement {
  if (key === "autoSend") {
    return h(
      "label",
      { class: "line" },
      checkbox(settings.autoSend, (v) => void update((s) => void (s.autoSend = v))),
      label,
    );
  }
  const input = h("input", { type: "number", value: String(settings[key]) });
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    void update((s) => void (s[key] = v)).then(() => (input.value = String(settings[key])));
  });
  return h("label", { class: "line" }, input, label);
}

function serverRow(s: ServerConfig): HTMLElement {
  const status = h("div", { class: "status" });
  const paint = () => {
    const x = state?.servers.find((y) => y.id === s.id);
    status.className = `status ${x?.status === "ok" ? "ok" : x?.status === "error" ? "err" : "muted"}`;
    status.textContent = !x
      ? ""
      : x.status === "ok"
        ? `${t("statusOk")} · ${x.serverName ?? ""} · ${t("tools", { n: x.toolCount })}`
        : x.status === "error"
          ? `${t("statusError")}: ${x.error ?? ""}`
          : x.status === "off"
            ? t("statusOff")
            : t("statusConnecting");
  };
  painters.push(paint);
  paint();
  const name = h("input", { type: "text", value: s.name, "aria-label": t("optName"), class: "name" });
  const url = h("input", { type: "url", value: s.url, "aria-label": t("optUrl"), class: "url", placeholder: DEFAULT_URL });
  const token = h("input", { type: "password", value: s.token, "aria-label": t("optToken"), class: "token", placeholder: t("optToken"), autocomplete: "off" });
  const warn = h("div", { class: "err small" });
  const commit = async () => {
    const local = isLocalUrl(url.value);
    warn.textContent = local ? "" : t("optOnlyLocal");
    if (!local) return;
    await update((f) => {
      const x = f.servers.find((y) => y.id === s.id);
      if (x) Object.assign(x, { name: name.value.trim() || x.name, url: url.value.trim(), token: token.value.trim() });
    });
  };
  for (const i of [name, url, token]) i.addEventListener("change", () => void commit());
  const enabled = checkbox(s.enabled, (v) => {
    void update((f) => {
      const x = f.servers.find((y) => y.id === s.id);
      if (x) x.enabled = v;
    });
  });
  const test = h("button", {}, t("optTest"));
  test.addEventListener("click", async () => {
    await commit();
    status.textContent = t("statusConnecting");
    await loadState(true);
  });
  const remove = h("button", {}, t("optRemove"));
  remove.addEventListener("click", async () => {
    await update((f) => {
      f.servers = f.servers.filter((x) => x.id !== s.id);
    });
    render();
  });
  return h("div", { class: "server" }, h("div", { class: "line" }, enabled, name, url), h("div", { class: "line" }, token, test, remove), warn, status);
}

function renderTools(): void {
  const box = document.getElementById("tools");
  if (!box) return;
  const all = [...(state?.tools ?? []), ...(state?.hiddenTools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!all.length) {
    box.replaceChildren(h("p", { class: "muted" }, t("optNoTools")));
    return;
  }
  const rows = all.map((tool) => {
    const select = h("select", { "aria-label": tool.name });
    for (const [v, label] of [
      ["ask", t("optAsk")],
      ["auto", t("optAuto")],
      ["off", t("optOff")],
    ] as const) {
      const o = h("option", { value: v }, label);
      if ((own(settings.policies, tool.name) ?? "ask") === v) o.selected = true;
      select.append(o);
    }
    select.addEventListener("change", () => {
      // the box of sites shows only under an "Auto" tool; a tool that leaves Auto forgets its sites
      drafts.delete(tool.name);
      checks.delete(tool.name);
      void update((s) => void (s.policies[tool.name] = select.value as Policy)).then(renderTools);
    });
    const auto = settings.policies[tool.name] === "auto";
    const row = h("tr", auto ? { class: "has-sites" } : {}, h("td", { class: "mono" }, tool.name), h("td", {}, select), h("td", { class: "muted small" }, (tool.description ?? "").slice(0, 200)));
    return auto ? [row, sitesRow(tool.name)] : [row];
  });
  const anyAuto = rows.some((r) => r.length > 1);
  const address = h("input", { type: "text", class: "try", value: tryAddress, "aria-label": t("optTryAddress"), placeholder: GEMINI, spellcheck: "false", "data-key": "try" });
  address.addEventListener("input", () => (tryAddress = address.value));
  // the box being typed in is drawn anew: the focus and the caret go to the new one
  const was = document.activeElement;
  const key = was instanceof HTMLElement && box.contains(was) ? was.dataset.key : undefined;
  const caret = was instanceof HTMLTextAreaElement || was instanceof HTMLInputElement ? [was.selectionStart ?? 0, was.selectionEnd ?? 0] : [0, 0];
  box.replaceChildren(
    ...(anyAuto ? [h("p", { class: "muted small" }, t("optSitesHelp")), h("label", { class: "line small" }, t("optTryAddress"), address)] : []),
    h("table", {}, h("tbody", {}, ...rows.flat())),
  );
  const now = key ? box.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`) : null;
  if (now) {
    now.focus();
    now.setSelectionRange(caret[0], caret[1]);
  }
}

const RE_ERRORS: Record<string, Key> = {
  "Unterminated group": "reUnterminatedGroup",
  "Unmatched ')'": "reUnmatchedParen",
  "Nothing to repeat": "reNothingToRepeat",
  "Unterminated character class": "reUnterminatedClass",
  "\\ at end of pattern": "reTrailingBackslash",
  "Range out of order in character class": "reRangeOrder",
  "Invalid group": "reInvalidGroup",
  "numbers out of order in {} quantifier": "reQuantifierOrder",
  "Invalid capture group name": "reGroupName",
};

/** Why a pattern is not a regular expression, in the page's language, with Chrome's own words after them. */
function reason(error: string): string {
  const key = RE_ERRORS[error];
  const said = key ? t(key) : error;
  return said === error ? error : `${said} (${error})`;
}

/** What the lines of sites say: each line that is not a regular expression; else that the syntax is right, the
 * lines that match any site, and which line matches the address to try. `ok`: every line is a regular expression. */
function checkSites(text: string): { ok: boolean; patterns: string[]; notes: { text: string; bad?: boolean }[] } {
  const lines = readSites(text);
  const bad = lines.filter((l) => l.error !== undefined);
  if (bad.length) {
    return { ok: false, patterns: [], notes: [...bad.map((l) => ({ text: t("optSitesBad", { n: l.line, error: reason(l.error ?? "") }), bad: true })), { text: t("optSitesNotSaved"), bad: true }] };
  }
  const notes: { text: string; bad?: boolean }[] = [{ text: lines.length ? t("optSitesOk", { n: lines.length }) : t("optSitesNone") }];
  for (const l of lines) {
    if (l.anySite) notes.push({ text: t("optSitesAny", { n: l.line }), bad: true });
    if (l.looseDot) notes.push({ text: t("optSitesLooseDot", { n: l.line }), bad: true });
  }
  const site = originOf(tryAddress);
  if (site && lines.length) {
    const hit = lines.find((l) => allowedOn([l.pattern], site));
    if (hit) notes.push({ text: t("optSitesMatch", { site, n: hit.line }) });
    else {
      notes.push({ text: t("optSitesNoMatch", { site }) });
      // written without https://: it matches the host alone
      const host = new URL(site).host;
      const near = lines.find((l) => allowedOn([l.pattern], host));
      if (near) notes.push({ text: t("optSitesNoScheme", { n: near.line, host, site }), bad: true });
    }
  }
  return { ok: true, patterns: lines.map((l) => l.pattern), notes };
}

/** Under an "Auto" tool: its sites, one pattern per line, saved when the box is left if every line is right. */
function sitesRow(tool: string): HTMLElement {
  const box = h("textarea", { class: "sites", rows: "2", spellcheck: "false", "aria-label": t("optSitesOf", { tool }), placeholder: GEMINI_SITE, "data-key": `sites:${tool}` });
  box.value = drafts.get(tool) ?? (own(settings.autoSites, tool) ?? []).join("\n");
  const out = h("div", { class: "checks small", "aria-live": "polite" });
  const show = () => out.replaceChildren(...(checks.get(tool) ?? []).map((n) => h("div", { class: n.bad ? "err" : "ok" }, n.text)));
  const check = () => {
    const got = checkSites(box.value);
    checks.set(tool, got.notes);
    show();
    return got;
  };
  box.addEventListener("input", () => drafts.set(tool, box.value));
  // on leaving the box, not on "change": a box drawn anew with what was typed has no change pending
  box.addEventListener("blur", () => {
    if (!drafts.has(tool)) return;
    const got = check();
    if (!got.ok) return;
    void update((s) => void (s.autoSites[tool] = got.patterns)).then(() => {
      drafts.delete(tool);
      checks.set(tool, [...got.notes, { text: t("optSitesSaved") }]);
      show();
    });
  });
  const test = h("button", {}, t("optCheck"));
  test.addEventListener("click", () => void check());
  show();
  return h("tr", { class: "sites-row" }, h("td", { colspan: "3" }, h("div", { class: "line" }, box, test), out));
}

/** The learned pages: each site with when it was learned, what of it was found, and Delete. */
async function renderLayouts(): Promise<void> {
  const box = document.getElementById("layouts");
  if (!box) return;
  const all = Object.entries(await loadLayouts()).sort(([a], [b]) => a.localeCompare(b));
  if (!all.length) {
    box.replaceChildren(h("p", { class: "muted" }, t("optNoLearned")));
    return;
  }
  const names = (roles: readonly Role[]) => roles.map((r) => t(`role_${r}`)).join(", ");
  const rows = all.map(([site, l]) => {
    const found = ROLES.filter((r) => l[r] !== undefined);
    const missing = ROLES.filter((r) => !found.includes(r));
    const about = [t("optLearnedAt", { date: new Date(l.at).toLocaleString() }), t("optParts", { n: found.length, all: ROLES.length })];
    if (missing.length) about.push(t("optMissing", { names: names(missing) }));
    if (l.picked?.length) about.push(t("optPickedParts", { names: names(l.picked) }));
    const del = h("button", {}, t("optDelete"));
    del.addEventListener("click", () => void storeLayout(site, null));
    return h("tr", { "data-site": site }, h("td", { class: "mono" }, site), h("td", { class: "muted small" }, about.join(" · ")), h("td", {}, del));
  });
  box.replaceChildren(h("table", {}, h("tbody", {}, ...rows)));
}

function render(): void {
  painters.length = 0;
  const addServer = h("button", {}, t("optAdd"));
  addServer.addEventListener("click", async () => {
    await update((f) => {
      f.servers.push({ id: `s${Date.now().toString(36)}`, name: `server${f.servers.length + 1}`, url: DEFAULT_URL, token: "", enabled: true });
    });
    render();
  });
  app.replaceChildren(
    h("header", {}, h("h1", {}, t("optTitle")), h("span", { id: "saved", class: "ok small" })),
    h("p", { class: "small" }, t("optHowTo")),
    h(
      "label",
      { class: "line big" },
      checkbox(settings.enabled, (v) => void update((s) => void (s.enabled = v))),
      t("optEnabled"),
    ),
    h("h2", {}, t("optServers")),
    h("p", { class: "muted small" }, t("optServersHelp")),
    ...settings.servers.map(serverRow),
    addServer,
    h("h2", {}, t("optTools")),
    h("p", { class: "muted small" }, t("optToolsHelp")),
    h("div", { id: "tools" }),
    h("h2", {}, t("optBehavior")),
    settingRow("autoSend", t("optAutoSend")),
    settingRow("maxRounds", t("optMaxRounds")),
    settingRow("maxResultChars", t("optMaxChars")),
    settingRow("callTimeoutSec", t("optTimeout")),
    h("h2", {}, t("optLearned")),
    h("p", { class: "muted small" }, t("optLearnedHelp")),
    h("div", { id: "layouts" }),
  );
  renderTools();
  void renderLayouts();
}

async function main(): Promise<void> {
  document.title = t("optTitle");
  settings = await loadSettings();
  render();
  // a tool allowed on Gemini's page shows here at once (the rest of the page keeps what is being typed)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LAYOUTS_KEY]) void renderLayouts();
    if (area !== "local" || !changes.settings) return;
    void loadSettings().then((fresh) => {
      // this page's own change: the table already shows it (a repaint would take the focus out of a box)
      if (JSON.stringify(fresh) === JSON.stringify(settings)) return;
      settings = fresh;
      renderTools();
    });
  });
  await loadState(false);
}

void main();
