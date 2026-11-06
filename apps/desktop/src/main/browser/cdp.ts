// A tab's own DevTools client: Electron's `webContents.debugger`, attached when the tab opens. There is no
// debugging port (spec §12.1). Calls from the API pass the allow list here as well as in the core, so a bug on one
// side never opens the door alone; the browser's own uses (the viewport's IME, drags and file chooser) go through
// `internal`, which never reaches the API.
import type { WebContents } from "electron";
import { isCdpCallAllowed, isCdpMethodAllowed } from "./contract";

export type CdpEventSink = (method: string, params: unknown) => void;

export class TabDebugger {
  private readonly internalListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private attached = false;

  constructor(private readonly contents: WebContents, private readonly forward: CdpEventSink) {}

  attach(): void {
    if (this.attached) return;
    this.contents.debugger.attach("1.3");
    this.attached = true;
    this.contents.debugger.on("message", (_event, method, params) => {
      for (const listener of this.internalListeners.get(method) ?? []) {
        try {
          listener(params as Record<string, unknown>);
        } catch {
          // An internal listener's mistake never stops the page's events.
        }
      }
      if (isCdpMethodAllowed(method)) this.forward(method, params);
    });
    this.contents.debugger.on("detach", () => {
      this.attached = false;
    });
  }

  /** A call from the API: allowlisted domains only. */
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!isCdpCallAllowed(method)) throw new Error(`${method} isn't allowed`);
    return this.internal(method, params);
  }

  /** The browser's own call, never the API's. */
  async internal(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.attached) this.attach();
    return this.contents.debugger.sendCommand(method, params ?? {});
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    let set = this.internalListeners.get(method);
    if (set === undefined) this.internalListeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  detach(): void {
    if (!this.attached) return;
    try {
      this.contents.debugger.detach();
    } catch {
      // Already gone with its tab.
    }
    this.attached = false;
  }
}
