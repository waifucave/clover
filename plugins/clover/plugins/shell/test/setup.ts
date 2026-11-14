import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// Diagnostic (temporary): which keydown listeners are live on the document's path, and where each came from.
const ledger = new Map<EventListenerOrEventListenerObject, string>();
(globalThis as { __keydownLedger?: () => string[] }).__keydownLedger = () => [...ledger.values()];
const owners = new Set<object>();
const ownerOf = (t: object, name: string): object | undefined => { for (let o: object | null = t; o !== null; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, name)) return o; return undefined; };
for (const t of [document, window, document.body, document.documentElement] as object[]) {
  const add = ownerOf(t, "addEventListener");
  const remove = ownerOf(t, "removeEventListener");
  if (add !== undefined && !owners.has(add)) {
    owners.add(add);
    const was = (add as EventTarget).addEventListener;
    (add as { addEventListener: unknown }).addEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
      if (type === "keydown" && l !== null && (this === document || this === window || this === document.body || this === document.documentElement)) {
        const who = this === document ? "document" : this === window ? "window" : "body/html";
        ledger.set(l, `${who}: ${(new Error().stack ?? "").split("\n").slice(2, 5).map((x) => x.trim().replace(/^at /, "").slice(0, 90)).join(" < ")}`);
      }
      return was.call(this, type, l, o);
    };
  }
  if (remove !== undefined && !owners.has(remove)) {
    owners.add(remove);
    const was = (remove as EventTarget).removeEventListener;
    (remove as { removeEventListener: unknown }).removeEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
      if (type === "keydown" && l !== null) ledger.delete(l);
      return was.call(this, type, l, o);
    };
  }
}
