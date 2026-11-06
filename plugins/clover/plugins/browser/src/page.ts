// The page side of the tool: one self-contained function, `pageScript`, run inside the tab through
// `Runtime.evaluate`, and `PageRunner`, which runs it in an isolated world of the tab's top frame.
//
// Why an isolated world (`Page.createIsolatedWorld`, as computer use's page runtime does): it shares the page's DOM but not
// its JavaScript, so the page can't see the script, call it, or change what `querySelectorAll` or `innerText` answer.
// The world lives as long as the document; refs are kept in it, in a WeakRef map, so `e12` from a `read` still means
// the same element at the next `click`. A new document gets a new world, and its refs carry on counting from where the
// last one stopped (the host passes the next number in), so a ref from an old page is never mistaken for one on the
// new page: it is simply not found.
//
// The script reads facts and acts on the DOM where the host tells it to; it never decides what's allowed. The
// secure-field floor and the picker rules are the host's (`floor.ts`), applied to the facts the script returns.
//
// `pageScript` is sent as source (`Function.prototype.toString`), so it must not use anything from outside its own
// body: no imports, no module constants, no helpers. A test holds it to that.
import { ToolFailure } from "./errors";
import type { ElementFacts, FocusReport } from "./floor";
import { SECURE_AUTOCOMPLETE } from "./floor";
import type { BrowserApi } from "./types";

export type PageOp = "read" | "inspect" | "point" | "at" | "focus" | "active" | "setValue" | "select" | "scrollTo" | "probe";

export interface PageCall {
  op: PageOp;
  /** The first ref number a new world uses. */
  base: number;
  /** The secure `autocomplete` tokens, from `floor.ts`, so the script's redaction matches the host's floor. */
  secure: readonly string[];
  args: Record<string, unknown>;
}

export interface PageReply {
  next: number;
  value?: unknown;
  error?: string;
}

/** One interactive element, as `read` lists it. `box` is x, y, width, height in the view's CSS pixels. */
export interface PageElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  /** A password, one-time-code or card field: its value is never read. */
  secure?: boolean;
  box: [number, number, number, number];
  offscreen?: boolean;
}

export interface PageRead {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; width: number; height: number };
  text: string;
  textLength: number;
  elements: PageElement[];
  omitted: number;
  frames: number;
}

export type PageGone = { gone: true };
export type PagePoint = PageGone | { hidden: true; label: string } | { x: number; y: number; facts: ElementFacts; label: string; covered?: string };
export type PageAt = { none: true } | { facts: ElementFacts; label: string; ref?: string };
export type PageInspect = PageGone | { facts: ElementFacts; label: string; disabled: boolean };
export type PageFocus = PageGone | { facts: ElementFacts; label: string; focused: boolean };
export type PageSetValue = PageGone | { value: string };
export type PageSelect = PageGone | { notSelect: true; label: string } | { noOption: true; options: string[] } | { disabledOption: string } | { chosen: string; label: string };
export type PageScrollTo = PageGone | { label: string };
export type PageProbe = { readyState: string; url: string; title: string; hasText?: boolean; matches?: boolean; badSelector?: string };

/**
 * The script. Runs in the page; every helper lives inside it. Returns `{ next, value }` or `{ next, error }`, where
 * `next` is the world's next ref number.
 */
export function pageScript(call: PageCall): PageReply {
  type State = { next: number; refs: Map<string, WeakRef<Element>>; ids: WeakMap<Element, string> };
  const G = globalThis as unknown as { __cloverBrowserTool?: State };
  let S = G.__cloverBrowserTool;
  if (S === undefined) {
    S = { next: Math.max(1, Math.floor(Number(call.base)) || 1), refs: new Map(), ids: new WeakMap() };
    Object.defineProperty(G, "__cloverBrowserTool", { value: S, enumerable: false });
  }
  const state = S;
  const args = call.args ?? {};
  const secureTokens = new Set((call.secure ?? []).map((t) => String(t).toLowerCase()));

  const clean = (s: unknown): string => (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
  /** Cut to `n` UTF-16 units, never between the halves of a surrogate pair. */
  const cut = (s: string, n: number): string => {
    if (s.length <= n) return s;
    let end = Math.max(0, n - 1);
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    return `${s.slice(0, end)}…`;
  };
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

  const refOf = (el: Element): string => {
    let r = state.ids.get(el);
    if (r === undefined) {
      r = `e${state.next++}`;
      state.ids.set(el, r);
      state.refs.set(r, new WeakRef(el));
    }
    return r;
  };
  const byRef = (ref: unknown): Element | undefined => {
    if (typeof ref !== "string") return undefined;
    const el = state.refs.get(ref)?.deref();
    return el !== undefined && el.isConnected ? el : undefined;
  };

  const factsOf = (el: Element): ElementFacts => ({
    tag: el.tagName.toUpperCase(),
    ...(el instanceof HTMLInputElement ? { type: el.type.toLowerCase() } : {}),
    autocomplete: el.getAttribute("autocomplete") ?? "",
    contentEditable: (el as HTMLElement).isContentEditable === true,
  });
  const isSecure = (el: Element): boolean => {
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password") return true;
    return (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).some((t) => secureTokens.has(t));
  };

  const ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem", "listbox",
  ]);
  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href");
    if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
    if (el instanceof HTMLInputElement) return el.type.toLowerCase() !== "hidden";
    const role = clean(el.getAttribute("role")).split(" ")[0] ?? "";
    if (ROLES.has(role)) return true;
    const h = el as HTMLElement;
    if (h.isContentEditable === true && !(h.parentElement?.isContentEditable === true)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0 && tag !== "BODY" && tag !== "HTML";
  };

  const roleOf = (el: Element): string => {
    const explicit = clean(el.getAttribute("role")).split(" ")[0];
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (el instanceof HTMLSelectElement) return el.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "file") return "file chooser";
      if (t === "color") return "color field";
      if (t === "date" || t === "time" || t === "datetime-local" || t === "month" || t === "week") return `${t} field`;
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable === true) return "textbox";
    return "clickable";
  };

  const textById = (el: Element, id: string): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const n = (typeof root.getElementById === "function" ? root.getElementById(id) : null) ?? document.getElementById(id);
    return n === null ? "" : (n.textContent ?? "");
  };
  const nameOf = (el: Element): string => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => textById(el, id)).join(" "));
      if (t) return t;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels !== undefined && labels !== null && labels.length > 0) {
      const t = clean(Array.from(labels).map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return clean(el.value) || t;
      if (t === "image") return clean(el.alt) || "image button";
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const p = clean(el.placeholder);
      if (p) return p;
    } else if (!(el instanceof HTMLSelectElement)) {
      const t = clean((el as HTMLElement).innerText ?? el.textContent);
      if (t) return t;
      const alt = clean(el.querySelector("img[alt]")?.getAttribute("alt"));
      if (alt) return alt;
    }
    return clean(el.getAttribute("title") ?? el.getAttribute("name") ?? "");
  };
  const labelOf = (el: Element): string => {
    const name = cut(nameOf(el), 60);
    return name ? `${roleOf(el)} "${name}"` : roleOf(el);
  };

  /** The rendered box, or undefined for an element nobody can see. Opacity isn't checked: a native check box is
   *  often drawn see-through over a custom one, and clicking it is right. */
  const shownBox = (el: Element): DOMRect | undefined => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return undefined;
    const cv = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
    if (typeof cv === "function" && !cv.call(el, { checkVisibilityCSS: true })) return undefined;
    if (el.closest("[aria-hidden=true], [inert]") !== null) return undefined;
    return r;
  };

  const deepActive = (): Element | null => {
    let a: Element | null = document.activeElement;
    while (a !== null && a.shadowRoot !== null && a.shadowRoot.activeElement !== null) a = a.shadowRoot.activeElement;
    return a;
  };
  const deepAt = (x: number, y: number): Element | null => {
    let t: Element | null = document.elementFromPoint(x, y);
    while (t !== null && t.shadowRoot !== null) {
      const inner = t.shadowRoot.elementFromPoint(x, y);
      if (inner === null || inner === t) break;
      t = inner;
    }
    return t;
  };
  const parentOf = (n: Node): Node | null => n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
  const contains = (outer: Node, inner: Node | null): boolean => {
    for (let n: Node | null = inner; n !== null; n = parentOf(n)) if (n === outer) return true;
    return false;
  };
  const interactiveAncestor = (el: Element): Element => {
    for (let n: Node | null = el; n !== null; n = parentOf(n)) {
      if (n instanceof Element && isInteractive(n)) return n;
    }
    return el;
  };

  const valueOf = (el: Element): Pick<PageElement, "value" | "checked" | "secure"> => {
    if (isSecure(el)) return { secure: true };
    if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase();
      if (t === "checkbox" || t === "radio") return { checked: el.indeterminate ? "mixed" : el.checked };
      if (t === "button" || t === "submit" || t === "reset" || t === "image" || t === "file") return {};
      return el.value ? { value: cut(el.value, 80) } : {};
    }
    if (el instanceof HTMLTextAreaElement) return el.value ? { value: cut(el.value, 80) } : {};
    if (el instanceof HTMLSelectElement) {
      const chosen = Array.from(el.selectedOptions).map((o) => clean(o.label || o.text)).join(", ");
      return chosen ? { value: cut(chosen, 80) } : {};
    }
    const aria = el.getAttribute("aria-checked");
    if (aria === "true" || aria === "false") return { checked: aria === "true" };
    if (aria === "mixed") return { checked: "mixed" };
    return {};
  };

  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter !== undefined) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const pageText = (): string => {
    const root = document.body ?? document.documentElement;
    const raw = root === null ? "" : ((root as HTMLElement).innerText ?? root.textContent ?? "");
    const lines = raw.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim());
    const out: string[] = [];
    for (const l of lines) {
      if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
      out.push(l);
    }
    return out.join("\n").trim();
  };

  const ops: Record<PageOp, () => unknown> = {
    read: () => {
      const maxText = num(args.maxText, 12_000);
      const maxElements = num(args.maxElements, 200);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const found: { el: Element; r: DOMRect; i: number; dist: number }[] = [];
      let frames = 0;
      let seen = 0;
      const visit = (root: Document | ShadowRoot): void => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if (++seen > 40_000) return;
          if (el.tagName === "IFRAME" || el.tagName === "FRAME") frames++;
          if (isInteractive(el)) {
            const r = shownBox(el);
            if (r !== undefined) {
              const dy = r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0;
              const dx = r.right < 0 ? -r.right : r.left > vw ? r.left - vw : 0;
              found.push({ el, r, i: found.length, dist: dx + dy });
            }
          }
          if (el.shadowRoot !== null) visit(el.shadowRoot);
        }
      };
      visit(document);
      // Over the cap, keep the elements nearest the view: they are the ones the next step is about.
      let kept = found;
      if (found.length > maxElements) kept = [...found].sort((a, b) => a.dist - b.dist || a.i - b.i).slice(0, maxElements).sort((a, b) => a.i - b.i);
      for (const [k, w] of state.refs) if (w.deref() === undefined) state.refs.delete(k);
      const elements: PageElement[] = kept.map(({ el, r, dist }) => {
        const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
        return {
          ref: refOf(el),
          role: roleOf(el),
          name: cut(nameOf(el), 80),
          ...valueOf(el),
          ...(disabled ? { disabled: true } : {}),
          box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] as [number, number, number, number],
          ...(dist > 0 ? { offscreen: true } : {}),
        };
      });
      const text = pageText();
      const doc = document.scrollingElement ?? document.documentElement;
      return {
        url: location.href,
        title: document.title,
        viewport: { width: vw, height: vh },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: doc?.scrollWidth ?? vw, height: doc?.scrollHeight ?? vh },
        text: cut(text, maxText),
        textLength: text.length,
        elements,
        omitted: found.length - kept.length,
        frames,
      } satisfies PageRead;
    },

    inspect: () => {
      const el = byRef(args.ref);
      if (el === undefined) return { gone: true };
      const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
      return { facts: factsOf(el), label: labelOf(el), disabled };
    },

    point: () => {
      const el = byRef(args.ref);
      if (el === undefined) return { gone: true };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let r = el.getBoundingClientRect();
      if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        r = el.getBoundingClientRect();
      }
      if (shownBox(el) === undefined) return { hidden: true, label: labelOf(el) };
      // The middle of the part of the element that is in view.
      const left = Math.max(r.left, 0);
      const right = Math.min(r.right, vw);
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, vh);
      if (right - left < 1 || bottom - top < 1) return { hidden: true, label: labelOf(el) };
      const x = Math.round((left + right) / 2);
      const y = Math.round((top + bottom) / 2);
      const hit = deepAt(x, y);
      const ok = hit !== null && (hit === el || contains(el, hit) || contains(hit, el)
        || (hit instanceof HTMLLabelElement && hit.control === el)
        || (hit.closest("label") as HTMLLabelElement | null)?.control === el);
      return { x, y, facts: factsOf(el), label: labelOf(el), ...(ok || hit === null ? {} : { covered: labelOf(interactiveAncestor(hit)) }) };
    },

    at: () => {
      const hit = deepAt(num(args.x, 0), num(args.y, 0));
      if (hit === null) return { none: true };
      // A label passes its click to its control, so the control is what gets pressed.
      const label = hit.closest("label") as HTMLLabelElement | null;
      const target = label?.control ?? interactiveAncestor(hit);
      return { facts: factsOf(target), label: labelOf(target), ...(isInteractive(target) ? { ref: refOf(target) } : {}) };
    },

    focus: () => {
      const el = byRef(args.ref);
      if (el === undefined) return { gone: true };
      (el as HTMLElement).focus({ preventScroll: false });
      if (args.select === true) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          try {
            el.select();
          } catch {
            // An input type without a selection (email, number in some engines): the typing replaces nothing then.
          }
        } else if ((el as HTMLElement).isContentEditable) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
      const active = deepActive();
      return { facts: factsOf(el), label: labelOf(el), focused: active === el || (active !== null && contains(el, active)) };
    },

    active: () => {
      const a = deepActive();
      if (a === null || a === document.body || a === document.documentElement) return { kind: "none" } satisfies FocusReport;
      if (a.tagName === "IFRAME" || a.tagName === "FRAME") return { kind: "frame" } satisfies FocusReport;
      return { kind: "element", facts: factsOf(a), label: labelOf(a), ref: refOf(a) } satisfies FocusReport;
    },

    setValue: () => {
      const el = byRef(args.ref);
      if (el === undefined) return { gone: true };
      if (!(el instanceof HTMLInputElement)) return { value: "" };
      setNativeValue(el, String(args.value ?? ""));
      return { value: el.value };
    },

    select: () => {
      const el = byRef(args.ref);
      if (el === undefined) return { gone: true };
      if (!(el instanceof HTMLSelectElement)) return { notSelect: true, label: labelOf(el) };
      const want = clean(args.option);
      const options = Array.from(el.options);
      const text = (o: HTMLOptionElement): string => clean(o.label || o.text);
      const lower = want.toLowerCase();
      const hit = options.find((o) => text(o) === want)
        ?? options.find((o) => o.value === want)
        ?? options.find((o) => text(o).toLowerCase() === lower)
        ?? (() => {
          const partial = options.filter((o) => text(o).toLowerCase().includes(lower));
          return partial.length === 1 ? partial[0] : undefined;
        })();
      if (hit === undefined) return { noOption: true, options: options.slice(0, 30).map((o) => cut(text(o), 60)) };
      if (hit.disabled) return { disabledOption: text(hit) };
      if (el.multiple) hit.selected = true;
      else el.selectedIndex = options.indexOf(hit);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { chosen: text(hit), label: labelOf(el) };
    },

    scrollTo: () => {
      const el = byRef(args.ref);
      if (el === undefined) return { gone: true };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return { label: labelOf(el) };
    },

    probe: () => {
      const reply: PageProbe = { readyState: document.readyState, url: location.href, title: document.title };
      if (typeof args.text === "string") reply.hasText = pageText().toLowerCase().replace(/\s+/g, " ").includes(clean(args.text).toLowerCase());
      if (typeof args.selector === "string") {
        try {
          reply.matches = document.querySelector(args.selector) !== null;
        } catch (e) {
          reply.badSelector = String((e as Error)?.message ?? e);
        }
      }
      return reply;
    },
  };

  try {
    const run = ops[call.op];
    if (run === undefined) return { next: state.next, error: `unknown page op ${String(call.op)}` };
    // The op first: it may hand out refs, and `next` must count them.
    const value = run();
    return { next: state.next, value };
  } catch (e) {
    return { next: state.next, error: String((e as Error)?.message ?? e) };
  }
}

/** The expression `Runtime.evaluate` runs for one call. A bundler that keeps function names (esbuild's `keepNames`)
 *  wraps functions in a `__name` helper that lives outside the script; a do-nothing one is defined for it, so a
 *  bundled host still sends a script that runs. */
export function pageExpression(call: PageCall): string {
  return `((__name) => (${pageScript.toString()})(${JSON.stringify(call)}))((f) => f)`;
}

/** The isolated world's name in the tab. */
export const WORLD_NAME = "clover-browser-tool";

/** Why the page could not be reached or its script failed, in words for the model. */
export class PageFailure extends ToolFailure {}

interface World {
  frameId: string;
  loaderId: string;
  contextId: number;
}

/** DevTools errors that mean the world went with its document. */
function contextGone(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Cannot find context|Execution context was destroyed|context with specified id|Inspected target navigated/i.test(m);
}

/** Runs `pageScript` in each tab's isolated world, making the world when the tab's document changes. */
export class PageRunner {
  private readonly worlds = new Map<string, World>();
  private readonly nextRef = new Map<string, number>();

  constructor(private readonly browser: () => BrowserApi) {}

  async call<T>(tab: string, op: PageOp, args: Record<string, unknown> = {}): Promise<T> {
    let world = await this.world(tab);
    let r: EvaluateResult;
    try {
      r = await this.evaluate(tab, world, op, args);
    } catch (e) {
      if (!contextGone(e)) throw e;
      // The document changed between the frame tree and the call: make the new document's world and try once more.
      this.worlds.delete(tab);
      world = await this.world(tab);
      r = await this.evaluate(tab, world, op, args);
    }
    if (r.exceptionDetails !== undefined) {
      const d = r.exceptionDetails;
      throw new PageFailure(`The page's script failed: ${d.exception?.description ?? d.text ?? "unknown error"}`);
    }
    const reply = r.result?.value as PageReply | undefined;
    if (reply === undefined || typeof reply !== "object") throw new PageFailure("The page didn't answer the browser tool's script.");
    if (typeof reply.next === "number" && Number.isFinite(reply.next)) this.nextRef.set(tab, Math.max(reply.next, this.nextRef.get(tab) ?? 1));
    if (reply.error !== undefined) throw new PageFailure(`The page's script failed: ${reply.error}`);
    return reply.value as T;
  }

  /** The tab's current document, by its loader id: it changes when a load commits a new document. */
  async currentLoader(tab: string): Promise<string> {
    const tree = await this.browser().cdp<{ frameTree?: { frame?: { loaderId?: string } } }>(tab, "Page.getFrameTree");
    return tree?.frameTree?.frame?.loaderId ?? "";
  }

  /** The loader id of the document the tab's last page call ran in. */
  lastLoader(tab: string): string | undefined {
    return this.worlds.get(tab)?.loaderId;
  }

  /** Forget a tab (it closed). */
  forget(tab: string): void {
    this.worlds.delete(tab);
    this.nextRef.delete(tab);
  }

  private async evaluate(tab: string, world: World, op: PageOp, args: Record<string, unknown>): Promise<EvaluateResult> {
    const call: PageCall = { op, base: this.nextRef.get(tab) ?? 1, secure: SECURE_AUTOCOMPLETE, args };
    return await this.browser().cdp<EvaluateResult>(tab, "Runtime.evaluate", {
      expression: pageExpression(call),
      contextId: world.contextId,
      returnByValue: true,
      awaitPromise: false,
      silent: true,
    });
  }

  private async world(tab: string): Promise<World> {
    const tree = await this.browser().cdp<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>(tab, "Page.getFrameTree");
    const frame = tree?.frameTree?.frame;
    if (typeof frame?.id !== "string") throw new PageFailure("The tab has no page loaded yet.");
    const loaderId = typeof frame.loaderId === "string" ? frame.loaderId : "";
    const known = this.worlds.get(tab);
    if (known !== undefined && known.frameId === frame.id && known.loaderId === loaderId) return known;
    const made = await this.browser().cdp<{ executionContextId?: number }>(tab, "Page.createIsolatedWorld", { frameId: frame.id, worldName: WORLD_NAME });
    if (typeof made?.executionContextId !== "number") throw new PageFailure("The browser didn't make a place in the page for the tool's script.");
    const world = { frameId: frame.id, loaderId, contextId: made.executionContextId };
    this.worlds.set(tab, world);
    return world;
  }
}

interface EvaluateResult {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}
