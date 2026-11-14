import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// Diagnostic (temporary): which keydown listeners are live on the document's path, and where each came from.
const ledger = new Map<EventListenerOrEventListenerObject, string>();
(globalThis as { __keydownLedger?: () => string[] }).__keydownLedger = () => [...ledger.values()];
const proto = EventTarget.prototype;
const add = proto.addEventListener;
const remove = proto.removeEventListener;
proto.addEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
  if (type === "keydown" && l !== null && (this === document || this === window || this === document.body || this === document.documentElement)) {
    const who = this === document ? "document" : this === window ? "window" : "body/html";
    ledger.set(l, `${who}: ${(new Error().stack ?? "").split("\n").slice(2, 5).map((s) => s.trim().replace(/^at /, "").slice(0, 90)).join(" < ")}`);
  }
  return add.call(this, type, l, o);
} as typeof add;
proto.removeEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
  if (type === "keydown" && l !== null) ledger.delete(l);
  return remove.call(this, type, l, o);
} as typeof remove;
