// MOSS's one preload, in every frame of its window (sandboxed, in an isolated world). It gives MOSS's own page
// (`moss-app://app/`, top frame only) the fixed bridge of shared/view.ts `MossBridge`, and a sealed card's frame
// (`moss-sealed://card/…`) its own channel, and nothing to any other document. There is no generic call: the page can ask
// only for what the bridge lists, and nothing it can reach answers a card or signs.
import { contextBridge, ipcRenderer } from "electron";
import type { MossBridge, MossView, Message, PictureFrameView } from "../shared/view";

const where = location.protocol;

// The trusted pointer-down report (§5.5): in every frame, a trusted pointerdown in this frame's own document is reported
// to the main process, which saw the press itself come to the window and binds the report to the sending frame. No
// payload: a page's script can neither call it nor make the event trusted. Capture phase, on the window, so no page stops
// it first.
window.addEventListener("pointerdown", (event) => {
  if (!event.isTrusted) return;
  ipcRenderer.send("moss:press-seen");
}, { capture: true });

// The talk key (Ctrl+Shift+Space) is MOSS's main process's (voice.ts): main reads it in its own before-input-event, and
// here, in every frame, it is kept from the page (capture phase, before any page listener), so it never types a space.
const keepTalkKey = (event: KeyboardEvent): void => {
  if (event.isTrusted && event.code === "Space" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
};
window.addEventListener("keydown", keepTalkKey, { capture: true });
window.addEventListener("keypress", keepTalkKey, { capture: true });

function listen<T extends unknown[]>(channel: string, fn: (...args: T) => void): () => void {
  const handler = (_event: unknown, ...args: unknown[]) => fn(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

if (where === "moss-app:" && location.host === "app" && window.top === window) {
  const bridge: MossBridge = {
    view: () => ipcRenderer.invoke("moss:view"),
    onView: (fn) => listen<[MossView]>("moss:view", fn),
    showing: (page) => ipcRenderer.send("moss:showing", page),
    conversation: (bot, before) => ipcRenderer.invoke("moss:conversation", { bot, ...(before !== undefined ? { before } : {}) }),
    onMessage: (fn) => listen<[string, Message]>("moss:message", fn),
    send: (bot, text, images) => ipcRenderer.invoke("moss:send", { bot, text, ...(images !== undefined ? { images } : {}) }),
    pickImages: () => ipcRenderer.invoke("moss:pick-images"),
    createBot: (name) => ipcRenderer.invoke("moss:create-bot", { name }),
    markRead: (bot) => ipcRenderer.send("moss:mark-read", { bot }),
    routines: (bot) => ipcRenderer.invoke("moss:routines", { bot }),
    pictures: (bot) => ipcRenderer.invoke("moss:pictures", { bot }),
    openPicture: (id) => ipcRenderer.invoke("moss:picture-open", { id }),
    closePicture: (id) => ipcRenderer.send("moss:picture-close", { id }),
    onPictureFrame: (fn) => listen<[PictureFrameView]>("moss:picture-frame", fn),
    cardFrame: (cardId) => ipcRenderer.invoke("moss:card-frame", { cardId }),
    onCardHeight: (fn) => listen<[string, number]>("moss:card-height", fn),
    talk: (phase) => ipcRenderer.send("moss:talk", { phase }),
    plugins: () => ipcRenderer.invoke("moss:plugins"),
    setAvailability: (server, tool, availability) => ipcRenderer.invoke("moss:set-availability", { server, tool, availability }),
    addPlugin: (from) => ipcRenderer.invoke("moss:add-plugin", from),
    settings: () => ipcRenderer.invoke("moss:settings"),
    botSettings: (bot) => ipcRenderer.invoke("moss:bot-settings", { bot }),
    setBotSetting: (bot, pluginId, key, value) => ipcRenderer.invoke("moss:set-bot-setting", { bot, pluginId, key, value }),
    setLevel: (computer, level) => ipcRenderer.invoke("moss:set-level", { computer, level }),
    setPermission: (server, tool, permission) => ipcRenderer.invoke("moss:set-permission", { server, tool, permission }),
    signIn: (pluginId, index, key) => ipcRenderer.invoke("moss:sign-in", { pluginId, index, ...(key !== undefined ? { key } : {}) }),
    signOut: (pluginId, index) => ipcRenderer.invoke("moss:sign-out", { pluginId, index }),
    botRecord: (id) => ipcRenderer.invoke("moss:bot-record", { id }),
    editBot: (id, patch) => ipcRenderer.invoke("moss:edit-bot", { id, patch }),
    models: () => ipcRenderer.invoke("moss:models"),
  };
  contextBridge.exposeInMainWorld("moss", bridge);
} else if (where === "moss-sealed:" && location.host === "card") {
  // A sealed frame's page: the token is its own (a single-use channel MOSS's store minted), and its answer goes back
  // through MOSS's main process's own press path (press.ts), signed there with MOSS's answer key.
  const token = new URLSearchParams(location.search).get("token") ?? "";
  contextBridge.exposeInMainWorld("mossSealed", {
    answer: (option: string, children?: readonly string[]) => ipcRenderer.invoke("moss:sealed-answer", { token, option, children }),
    visible: (visible: boolean) => void ipcRenderer.send("moss:sealed-visible", { token, visible }),
    fresh: (seen: boolean, ms: number) => void ipcRenderer.send("moss:sealed-fresh", { token, seen, ms }),
    pressed: (what: string) => void ipcRenderer.send("moss:sealed-press", { token, what }),
    size: (height: number) => void ipcRenderer.send("moss:sealed-size", { token, height }),
    review: (peek?: boolean) => ipcRenderer.invoke("moss:sealed-review", { token, ...(peek === true ? { peek: true } : {}) }),
  });
}
