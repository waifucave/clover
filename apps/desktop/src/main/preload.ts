// The one preload, in every frame of every app window (sandboxed, in an isolated world). It exposes the layer bridge
// to the core's root (`clover-core://app/`) and to plugin layers (`clover-plugin://<layer>/`), and nothing to any
// other document: an `about:blank` or srcdoc frame a plugin makes, a sealed card. The main process binds every call
// to the frame it came from, so the bridge carries no authority of its own beyond the mount token in the URL.
import { contextBridge, ipcRenderer } from "electron";
import type { LayerBridge, LayerMessage } from "@waifucave/clover-plugin-sdk/ui/bridge";

const where = location.protocol;
const isRoot = where === "clover-core:" && location.host === "app" && window.top === window;
const isLayer = where === "clover-plugin:";

if (isRoot || isLayer) {
  const token = isLayer ? new URLSearchParams(location.search).get("mount") ?? undefined : undefined;
  const listeners = new Set<(m: LayerMessage) => void>();
  ipcRenderer.on("clover:message", (_event, message: LayerMessage) => {
    for (const l of listeners) {
      try {
        l(message);
      } catch (err) {
        console.error(err);
      }
    }
  });  const bridge: LayerBridge = {
    token,
    describe: () => ipcRenderer.invoke("clover:describe", { token }),
    resolve: (mount, spot, key, hints) => ipcRenderer.invoke("clover:resolve", { mount, spot, key, hints }),
    entries: (mount, spot, key) => ipcRenderer.invoke("clover:entries", { mount, spot, key }),
    setProps: (child, props) => ipcRenderer.send("clover:props", { child, props }),
    callback: (id, args) => ipcRenderer.send("clover:callback", { id, args }),
    reportSize: (height) => ipcRenderer.send("clover:size", { height }),
    release: (mounts) => ipcRenderer.send("clover:release", { mounts: [...mounts] }),
    reload: (child) => ipcRenderer.invoke("clover:reload", { child }),
    sleep: (child) => ipcRenderer.send("clover:sleep", { child }),
    wake: (child) => ipcRenderer.invoke("clover:wake", { child }),
    rectReply: (id, rect) => ipcRenderer.send("clover:rect-reply", { id, rect }),
    menu: (mount, items, x, y) => ipcRenderer.invoke("clover:menu", { mount, items, x, y }),
    surface: (request) => ipcRenderer.send("clover:surface", request),
    surfaceEnvironment: () => ipcRenderer.invoke("clover:surface-environment", {}),
    open: (mount, target) => ipcRenderer.invoke("clover:open", { mount, target }),
    viewFrame: (mount, name, rect, used) => ipcRenderer.send("clover:view-frame", { mount, name, rect, used: used === true }),
    webFrame: (mount, rect) => ipcRenderer.send("clover:web-frame", { mount, rect }),
    activeSession: (mount, session) => ipcRenderer.send("clover:active-session", { mount, session }),
    userSend: (mount, to, message) => ipcRenderer.invoke("clover:user-send", { mount, to, message }),
    api: (mount, method, params) => ipcRenderer.invoke("clover:api", { mount, method, params }),
    terminalInput: (mount, terminalId, input) => ipcRenderer.invoke("clover:terminal-input", { mount, terminalId, input }),
    dragOffer: (mount, offer) => ipcRenderer.invoke("clover:drag-offer", { mount, offer }),
    dragClaim: (mount, token) => ipcRenderer.invoke("clover:drag-claim", { mount, token }),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  contextBridge.exposeInMainWorld("cloverLayer", bridge);
  if (isRoot) {
    contextBridge.exposeInMainWorld("cloverRoot", {
      frameMetrics: (m: { top: number; start: number; end: number }) => ipcRenderer.send("clover:frame-metrics", m),
      command: (name: string) => ipcRenderer.send("clover:root-command", { name }),
      // The core's own pages (the welcome guide, the plugin manager): a fixed set of calls, by name.
      call: (name: string, params?: unknown) => ipcRenderer.invoke("clover:root-call", { name, params }),
    });
  }
} else if (where === "clover-sealed:") {
  // A sealed frame's page: the token is its own (a single-use channel the store minted), and its answer goes back
  // through the main process's own path — signed there with the answer key, never a plugin's connection's.
  const token = new URLSearchParams(location.search).get("token") ?? "";
  contextBridge.exposeInMainWorld("cloverSealed", {
    answer: (option: string, children?: readonly string[]) => ipcRenderer.invoke("clover:sealed-answer", { token, option, children }),
    visible: () => ipcRenderer.invoke("clover:sealed-visible", { token }),
  });
}
