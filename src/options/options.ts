// The options page: servers, tool policies, behavior. Every change is saved at once, into the settings as they
// are stored then: the popup or "Always allow" on Gemini's page may have changed others meanwhile.

import { isLocalUrl, loadSettings, saveSettings, type BridgeState, type Policy, type Request, type ServerConfig, type Settings } from "../shared/config.ts";
import { t } from "../shared/i18n.ts";
import { h } from "../content/ui.ts";

let settings: Settings;
let state: BridgeState | undefined;
const app = document.getElementById("app") as HTMLElement;

/** Applies one change to the stored settings (read again first) and keeps the page's copy in step. */
async function update(change: (s: Settings) => void): Promise<void> {
  const fresh = await loadSettings();
  change(fresh);
  await saveSettings(fresh);
  settings = fresh;
  const s = document.getElementById("saved");
  if (s) {
    s.textContent = t("optSaved");
    setTimeout(() => (s.textContent = ""), 1200);
  }
}

async function loadState(refresh: boolean): Promise<void> {
  state = await chrome.runtime.sendMessage<Request, BridgeState>({ type: "getState", refresh });
}

function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const c = h("input", { type: "checkbox" });
  c.checked = checked;
  c.addEventListener("change", () => onChange(c.checked));
  return c;
}

function numberInput(value: number, min: number, max: number, onChange: (v: number) => void): HTMLInputElement {
  const i = h("input", { type: "number", min: String(min), max: String(max), value: String(value) });
  i.addEventListener("change", () => {
    const v = Number(i.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return i;
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
  paint();
  const name = h("input", { type: "text", value: s.name, "aria-label": t("optName"), class: "name" });
  const url = h("input", { type: "url", value: s.url, "aria-label": t("optUrl"), class: "url", placeholder: "http://127.0.0.1:7341/mcp" });
  const token = h("input", { type: "password", value: s.token, "aria-label": t("optToken"), class: "token", placeholder: t("optToken"), autocomplete: "off" });
  const warn = h("div", { class: "err small" });
  const commit = async () => {
    warn.textContent = isLocalUrl(url.value) ? "" : t("optOnlyLocal");
    if (!isLocalUrl(url.value)) return;
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
    paint();
    renderTools();
  });
  const remove = h("button", {}, t("optRemove"));
  remove.addEventListener("click", async () => {
    await update((f) => {
      f.servers = f.servers.filter((x) => x.id !== s.id);
    });
    render();
  });
  return h(
    "div",
    { class: "server" },
    h("div", { class: "line" }, enabled, name, url),
    h("div", { class: "line" }, token, test, remove),
    warn,
    status,
  );
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
    select.addEventListener("change", () => {
      void update((f) => {
        f.policies[tool.name] = select.value as Policy;
      });
    });
    return h("tr", {}, h("td", { class: "mono" }, tool.name), h("td", {}, select), h("td", { class: "muted small" }, (tool.description ?? "").slice(0, 200)));
  });
  box.replaceChildren(h("table", {}, h("tbody", {}, ...rows)));
}

function render(): void {
  const addServer = h("button", {}, t("optAdd"));
  addServer.addEventListener("click", async () => {
    await update((f) => {
      f.servers.push({ id: `s${Date.now().toString(36)}`, name: `server${f.servers.length + 1}`, url: "http://127.0.0.1:7341/mcp", token: "", enabled: true });
    });
    render();
  });
  app.replaceChildren(
    h("header", {}, h("h1", {}, t("optTitle")), h("span", { id: "saved", class: "ok small" })),
    h(
      "label",
      { class: "line big" },
      checkbox(settings.enabled, (v) => {
        void update((f) => {
          f.enabled = v;
        });
      }),
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
    h(
      "label",
      { class: "line" },
      checkbox(settings.autoRunAll, (v) => {
        void update((f) => {
          f.autoRunAll = v;
        });
      }),
      t("optAutoRunAll"),
    ),
    h(
      "label",
      { class: "line" },
      checkbox(settings.autoSend, (v) => {
        void update((f) => {
          f.autoSend = v;
        });
      }),
      t("optAutoSend"),
    ),
    h(
      "label",
      { class: "line" },
      numberInput(settings.maxRounds, 1, 200, (v) => {
        void update((f) => {
          f.maxRounds = v;
        });
      }),
      t("optMaxRounds"),
    ),
    h(
      "label",
      { class: "line" },
      numberInput(settings.maxResultChars, 1000, 200000, (v) => {
        void update((f) => {
          f.maxResultChars = v;
        });
      }),
      t("optMaxChars"),
    ),
    h(
      "label",
      { class: "line" },
      numberInput(settings.callTimeoutSec, 5, 3600, (v) => {
        void update((f) => {
          f.callTimeoutSec = v;
        });
      }),
      t("optTimeout"),
    ),
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
  render();
}

void main();
