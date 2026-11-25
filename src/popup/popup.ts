// The toolbar popup: on/off, the servers at a glance, links to Gemini and the options.

import { loadSettings, saveSettings, type BridgeState, type Request } from "../shared/config.ts";
import { t } from "../shared/i18n.ts";
import { h } from "../content/ui.ts";

const app = document.getElementById("app") as HTMLElement;

async function render(refresh: boolean): Promise<void> {
  const settings = await loadSettings();
  const state = await chrome.runtime.sendMessage<Request, BridgeState | undefined>({ type: "getState", refresh });
  const toggle = h("input", { type: "checkbox" });
  toggle.checked = settings.enabled;
  toggle.addEventListener("change", async () => {
    settings.enabled = toggle.checked;
    await saveSettings(settings);
    await render(true);
  });
  const servers = (state?.servers ?? []).map((s) =>
    h(
      "div",
      { class: "small" },
      h("strong", {}, s.name),
      " ",
      h(
        "span",
        { class: s.status === "ok" ? "ok" : s.status === "error" ? "err" : "muted" },
        { off: t("statusOff"), ok: t("statusOk"), error: t("statusError"), connecting: t("statusConnecting") }[s.status],
      ),
      s.status === "ok" ? ` · ${t("tools", { n: s.toolCount })}` : "",
      s.error ? h("div", { class: "err" }, s.error) : null,
    ),
  );
  const gemini = h("button", {}, t("popupOpenGemini"));
  gemini.addEventListener("click", () => void chrome.tabs.create({ url: "https://gemini.google.com/app" }));
  const options = h("button", {}, t("settings"));
  options.addEventListener("click", () => void chrome.runtime.openOptionsPage());
  const refreshBtn = h("button", {}, t("refresh"));
  refreshBtn.addEventListener("click", () => void render(true));
  const help = settings.enabled && !(state?.servers ?? []).some((s) => s.status === "ok") ? [h("p", { class: "small muted" }, t("noServer"))] : [];
  app.replaceChildren(
    h("h1", {}, "Gemini MCP Bridge"),
    h("label", { class: "line" }, toggle, t("optEnabled")),
    ...servers,
    ...help,
    h("div", { class: "line" }, gemini, options, refreshBtn),
  );
}

void render(false);
