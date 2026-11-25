// The page script. It goes into a tab only when the user turns the bridge on there (the extension's icon), and
// leaves when they turn it off; a reload of the page puts it in again, another site does not.
// On gemini.google.com it knows the page; on any other chat page it finds its way (generic.ts).

import { startBridge } from "./bridge.ts";
import { GeminiPage } from "./gemini.ts";
import { GenericPage } from "./generic.ts";
import type { Page } from "./page.ts";

type Message = { type: "ping" } | { type: "deactivate" };

const scope = globalThis as { __gmbStop?: () => void };
// put in a second time: the first one gives way
scope.__gmbStop?.();
// left behind by the extension before an update (another script world): its elements go too
for (const el of document.querySelectorAll("gmb-status, gmb-card, gmb-overlay, gmb-picker")) el.remove();

/** With localStorage["gmb-generic"] = "1", gemini.google.com too is handled as an unknown page (for testing). */
function chooseGeneric(): boolean {
  try {
    if (localStorage.getItem("gmb-generic") === "1") return true;
  } catch {
    // storage blocked
  }
  return location.hostname !== "gemini.google.com";
}

const page: Page = chooseGeneric() ? new GenericPage() : new GeminiPage();
const stopBridge = startBridge(page);

const onMessage = (msg: Message, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  if (msg.type === "ping") sendResponse("pong");
  else if (msg.type === "deactivate") {
    stop();
    sendResponse(true);
  }
  return false;
};

function stop(): void {
  stopBridge();
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    // the extension is gone already
  }
  if (scope.__gmbStop === stop) delete scope.__gmbStop;
}

chrome.runtime.onMessage.addListener(onMessage);
scope.__gmbStop = stop;
