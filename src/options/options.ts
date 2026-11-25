// The options page: servers, tool policies, behavior. Every change is saved at once, into the settings as they
// are stored then: "Always allow" on Gemini's page may have changed others meanwhile.

import { DEFAULT_URL, isLocalUrl, loadSettings, updateSettings, type BridgeState, type Policy, type Request, type ServerConfig, type Settings } from "../shared/config.ts";
import { h } from "../shared/dom.ts";
import { t } from "../shared/i18n.ts";

let settings: Settings;
let state: BridgeState | undefined;
const app = document.getElementById("app") as HTMLElement;
/** Repaints the status line of each server once the service worker answered. */
const painters: (() => void)[] = [];

async function update(change: (s: Settings) => void): Promise<void> {
  settings = await updateSettings(change);
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
      if ((settings.policies[tool.name] ?? "ask") === v) o.selected = true;
      select.append(o);
    }
    select.addEventListener("change", () => void update((s) => void (s.policies[tool.name] = select.value as Policy)));
    return h("tr", {}, h("td", { class: "mono" }, tool.name), h("td", {}, select), h("td", { class: "muted small" }, (tool.description ?? "").slice(0, 200)));
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
  );
  renderTools();
}

async function main(): Promise<void> {
  document.title = t("optTitle");
  settings = await loadSettings();
  render();
  // a tool allowed on Gemini's page shows here at once (the rest of the page keeps what is being typed)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    void loadSettings().then((fresh) => {
      settings = fresh;
      renderTools();
    });
  });
  await loadState(false);
}

void main();
