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
  });
  const bridge: LayerBridge = {
    token,
    describe: () => ipcRenderer.invoke("clover:describe", { token }),
    resolve: (mount, spot, key, hints) => ipcRenderer.invoke("clover:resolve", { mount, spot, key, hints }),
    setProps: (child, props) => ipcRenderer.send("clover:props", { child, props }),
    callback: (id, args) => ipcRenderer.send("clover:callback", { id, args }),
    reportSize: (height) => ipcRenderer.send("clover:size", { height }),
    release: (mounts) => ipcRenderer.send("clover:release", { mounts: [...mounts] }),
    reload: (child) => ipcRenderer.invoke("clover:reload", { child }),
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
    });
  }
}
