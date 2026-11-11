// The core's own pages, drawn in a window's root over whatever fills it (spec §5.8): the welcome setup guide (§3.3)
// and safe mode's plugin manager. Core code only, as the rest of the root: plain DOM, no plugin's, no inline styles
// (the root's CSP), and the daemon only through the main process's checked calls (`cloverRoot.call`). A key the user
// pastes goes from its field to that call and nowhere else: never stored here, never shown again, never logged.

import { orderProviders, SEARCH_FROM } from "./provider-order";

export type Translate = (key: string, params?: Record<string, string | number>) => string;
export type Call = (name: string, params?: unknown) => Promise<unknown>;

interface ProviderView {
  id: string;
  name: string;
  terms?: { url: string } | { text: string };
  auth: { index: number; method: "api-key" | "oauth-pkce" | "custom"; state: string; account?: string; help?: string }[];
}

interface ManagedPlugin {
  id: string;
  name: string;
  state: string;
  enabled: boolean;
  source: string;
  reason?: string;
  child: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

function button(label: string, run: () => void | Promise<void>, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = el("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", () => {
    b.disabled = true;
    void Promise.resolve(run()).finally(() => {
      if (b.isConnected) b.disabled = false;
    });
  });
  return b;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") : String(err);
}

/** A page's frame: a dialog over the window with a title, a body and its actions. */
function frame(host: HTMLElement, title: string, onClose: (() => void) | undefined, t: Translate): { body: HTMLElement; actions: HTMLElement; status: HTMLElement } {
  host.replaceChildren();
  host.hidden = false;
  const body = el("div", { class: "clover-page__body" });
  const actions = el("div", { class: "clover-page__actions" });
  const status = el("p", { class: "clover-page__status", role: "status", "aria-live": "polite" });
  const head = el("header", { class: "clover-page__head" }, el("h1", {}, title));
  if (onClose !== undefined) head.append(button(t("safe.close"), onClose, { class: "clover-page__close" }));
  host.append(el("section", { class: "clover-page", role: "dialog", "aria-modal": "true", "aria-label": title }, head, body, status, actions));
  return { body, actions, status };
}

// -------------------------------------------------------------------------------------------------
// The welcome setup guide
// -------------------------------------------------------------------------------------------------

export async function showWelcome(host: HTMLElement, t: Translate, call: Call, done: () => void): Promise<void> {
  const page = frame(host, t("welcome.title"), undefined, t);
  page.body.append(el("p", {}, t("welcome.intro")), el("p", { class: "clover-page__note" }, t("welcome.no-claude")));
  const search = el("input", { type: "search", class: "clover-page__search", autocomplete: "off", spellcheck: "false", "aria-label": t("welcome.search"), placeholder: t("welcome.search"), "data-clover-search": "" });
  search.hidden = true;
  const list = el("div", { class: "clover-page__list" }, el("p", {}, t("welcome.loading")));
  page.body.append(search, list);
  let all: ProviderView[] = [];
  const show = () => {
    const shown = orderProviders(all, search.value);
    list.replaceChildren(...(shown.length > 0 ? shown.map((p) => provider(p)) : [el("p", {}, t("welcome.no-match"))]));
  };
  search.addEventListener("input", show);
  const finish = async () => {
    await call("welcome.done");
    done();
  };
  const start = button(t("welcome.done"), finish, { class: "clover-page__primary", "data-clover-welcome": "start" });
  page.actions.append(button(t("welcome.skip"), finish, { "data-clover-welcome": "skip" }), start);
  const draw = async () => {
    let providers: ProviderView[];
    try {
      providers = ((await call("welcome.providers")) as { providers: ProviderView[] }).providers;
    } catch (err) {
      list.replaceChildren(el("p", {}, t("welcome.failed", { error: message(err) })));
      return;
    }
    if (providers.length === 0) {
      list.replaceChildren(el("p", {}, t("welcome.none")));
      return;
    }
    const ready = providers.filter((p) => p.auth.some((a) => a.state === "signed-in" || a.state === "refreshing")).length;
    page.status.textContent = ready > 0 ? t("welcome.ready", { count: ready }) : "";
    start.disabled = false;
    all = providers;
    search.hidden = providers.length < SEARCH_FROM;
    show();
  };
  const provider = (p: ProviderView): HTMLElement => {
    const box = el("article", { class: "clover-page__item", "data-clover-provider": p.id }, el("h2", {}, p.name));
    // The terms come first (§5.7): each sign-in waits until they are accepted.
    let accepted = p.terms === undefined;
    const signIns: HTMLElement[] = [];
    if (p.terms !== undefined) {
      const tick = el("input", { type: "checkbox", id: `terms-${p.id}`, "data-clover-terms": p.id });
      tick.addEventListener("change", () => {
        accepted = tick.checked;
        for (const s of signIns) s.toggleAttribute("data-disabled", !accepted);
        for (const c of box.querySelectorAll<HTMLButtonElement | HTMLInputElement>("[data-needs-terms]")) c.disabled = !accepted;
      });
      const terms = "url" in p.terms
        ? button(t("welcome.terms", { provider: p.name }), () => call("welcome.openTerms", { id: p.id }).then(() => undefined, (err) => void (page.status.textContent = t("welcome.failed", { error: message(err) }))), { class: "clover-page__link" })
        : el("blockquote", { class: "clover-page__terms" }, p.terms.text);
      box.append(terms, el("label", { class: "clover-page__check", for: `terms-${p.id}` }, tick, t("welcome.terms-accept", { provider: p.name })));
    }
    for (const a of p.auth) {
      const row = el("div", { class: "clover-page__auth", "data-clover-auth": `${p.id}#${a.index}` });
      signIns.push(row);
      if (a.state === "signed-in" || a.state === "refreshing") {
        row.append(el("p", { class: "clover-page__ok" }, `${t("welcome.signed-in")}${a.account !== undefined ? ` (${a.account})` : ""}`));
      } else if (a.method === "api-key") {
        const field = el("input", { type: "password", autocomplete: "off", spellcheck: "false", "aria-label": t("welcome.key-label", { provider: p.name }), placeholder: t("welcome.paste-key"), "data-needs-terms": "", "data-clover-key": `${p.id}#${a.index}` });
        field.disabled = !accepted;
        const save = button(t("welcome.save-key"), async () => {
          const key = field.value;
          if (key.trim() === "") return;
          try {
            await call("welcome.signIn", { id: p.id, index: a.index, key });
            field.value = "";
            page.status.textContent = t("welcome.key-saved");
            await draw();
            page.status.textContent = t("welcome.key-saved");
          } catch (err) {
            field.value = "";
            page.status.textContent = t("welcome.failed", { error: message(err) });
          }
        }, { "data-needs-terms": "", "data-clover-save": `${p.id}#${a.index}` });
        save.disabled = !accepted;
        if (a.help !== undefined) row.append(el("p", { class: "clover-page__note" }, a.help));
        row.append(el("label", { class: "clover-page__field" }, t("welcome.key-label", { provider: p.name }), field), save);
      } else {
        const go = button(t("welcome.sign-in"), async () => {
          try {
            const r = (await call("welcome.signIn", { id: p.id, index: a.index })) as { state: string; opened: boolean };
            page.status.textContent = r.opened ? t("welcome.waiting") : "";
            await draw();
          } catch (err) {
            page.status.textContent = t("welcome.failed", { error: message(err) });
          }
        }, { "data-needs-terms": "", "data-clover-signin": `${p.id}#${a.index}` });
        go.disabled = !accepted;
        row.append(go);
      }
      box.append(row);
    }
    return box;
  };
  await draw();
}

// -------------------------------------------------------------------------------------------------
// Safe mode's plugin manager
// -------------------------------------------------------------------------------------------------

export async function showPlugins(host: HTMLElement, t: Translate, call: Call, close: () => void): Promise<void> {
  const page = frame(host, t("safe.title"), () => void call("page.close").finally(close), t);
  page.body.append(el("p", {}, t("safe.intro")));
  const list = el("div", { class: "clover-page__list" }, el("p", {}, t("safe.loading")));
  page.body.append(list);
  const draw = async () => {
    let plugins: ManagedPlugin[];
    try {
      plugins = ((await call("plugins.list")) as { plugins: ManagedPlugin[] }).plugins;
    } catch (err) {
      list.replaceChildren(el("p", {}, t("safe.failed", { error: message(err) })));
      return;
    }
    if (plugins.length === 0) {
      list.replaceChildren(el("p", {}, t("safe.none")));
      return;
    }
    list.replaceChildren(...plugins.map((p) => {
      const state = p.state === "found" ? t("safe.state.found") : p.state === "blocked" ? t("safe.state.blocked") : p.state === "invalid" ? t("safe.state.invalid") : p.enabled ? t("safe.on") : t("safe.off");
      const row = el("article", { class: "clover-page__item", "data-clover-plugin": p.id },
        el("h2", {}, p.name),
        el("p", { class: "clover-page__note" }, `${p.id} · ${state}${p.reason !== undefined ? ` · ${p.reason}` : ""}`));
      const acts = el("div", { class: "clover-page__row" });
      const act = async (name: string) => {
        try {
          await call(name, { id: p.id });
          page.status.textContent = "";
          await draw();
        } catch (err) {
          page.status.textContent = t("safe.failed", { error: message(err) });
        }
      };
      if (p.enabled) acts.append(button(t("safe.turn-off"), () => act("plugins.turnOff"), { "data-clover-turn-off": p.id }));
      if (!p.child) acts.append(button(t("safe.remove"), () => act("plugins.remove"), { "data-clover-remove": p.id }));
      row.append(acts);
      return row;
    }));
  };
  await draw();
}

// -------------------------------------------------------------------------------------------------
// The app's own key dialog (the Plugins page's `ui.secret`): one plugin's one key, entered, replaced or removed here and
// nowhere else. The plugin and the key are main's; the key goes from the field to main's call and is never shown again.
// -------------------------------------------------------------------------------------------------

/** How long the key dialog's acting buttons ignore presses after it is drawn, re-drawn or comes back into view (the
 *  sealed cards' rule): the dialog opens right after a click on the Plugins page, so a double-click's second press, or
 *  a press the page timed, must land on nothing. */
export const KEY_ARM_MS = 500;

/** When the dialog's acting buttons take a press: a real one (`isTrusted`), the dialog in view, and `KEY_ARM_MS` after
 *  the last draw and after it last came into view. "In view" is this document's: it doesn't see another window covering
 *  the dialog (the sealed cards' occlusion checks aren't here; low risk, on the backlog). */
export class PressGuard {
  #drawnAt: number;
  #visibleAt: number;
  #visible = true;
  constructor(private readonly now: () => number = () => Date.now()) {
    this.#drawnAt = now();
    this.#visibleAt = this.#drawnAt;
  }
  /** The dialog was drawn again: every acting button waits again. */
  rearm(): void {
    this.#drawnAt = this.now();
  }
  seen(visible: boolean): void {
    if (visible && !this.#visible) this.#visibleAt = this.now();
    this.#visible = visible;
  }
  takes(e: { isTrusted: boolean }): boolean {
    const t = this.now();
    return e.isTrusted && this.#visible && t - this.#drawnAt >= KEY_ARM_MS && t - this.#visibleAt >= KEY_ARM_MS;
  }
}

function guarded(label: string, guard: PressGuard, run: () => void | Promise<void>, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = el("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", (e) => {
    if (b.disabled || !guard.takes(e)) return;
    b.disabled = true;
    void Promise.resolve(run()).finally(() => {
      if (b.isConnected) b.disabled = false;
    });
  });
  return b;
}

type KeyView = { session: string; plugin: string; label: string; set: boolean };

export async function showKey(host: HTMLElement, t: Translate, call: Call, close: () => void, now: () => number = () => Date.now()): Promise<void> {
  const closeIt = () => void call("page.close").finally(close);
  const named = (v: KeyView): KeyView => (v.label === "" ? { ...v, label: t("key.api-key") } : v);
  let view: KeyView;
  try {
    view = named((await call("key.view")) as KeyView);
  } catch (err) {
    const page = frame(host, t("key.title-plain"), closeIt, t);
    page.body.append(el("p", {}, t("key.failed", { error: message(err) })));
    return;
  }
  const page = frame(host, t("key.title", { plugin: view.plugin }), closeIt, t);
  const guard = new PressGuard(now);
  const section = host.querySelector("section");
  if (section !== null && typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      for (const e of entries) guard.seen(e.isIntersecting && e.intersectionRatio > 0);
    }).observe(section);
  }
  const onVisibility = () => guard.seen(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", onVisibility);
  const state = el("p", { class: "clover-page__note", "data-clover-key-state": view.set ? "set" : "unset" });
  const field = el("input", { type: "password", autocomplete: "off", spellcheck: "false", "aria-label": view.label, placeholder: t("key.paste"), "data-clover-key-field": "" });
  // The removal's second step: its own row above the field, never where Remove was.
  const confirmRow = el("div", { class: "clover-page__row", role: "group", "data-clover-key-confirm": "" });
  confirmRow.hidden = true;
  const act = async (name: "key.save" | "key.remove", params: Record<string, unknown>, done: string) => {
    try {
      draw(named((await call(name, { ...params, session: view.session })) as KeyView));
      page.status.textContent = t(done);
    } catch (err) {
      draw(view);
      page.status.textContent = t("key.failed", { error: message(err) });
    }
  };
  const save = guarded(t("key.save"), guard, async () => {
    const value = field.value;
    field.value = "";
    await act("key.save", { value }, "key.saved");
  }, { class: "clover-page__primary", "data-clover-key-save": "" });
  const remove = guarded(t("key.remove"), guard, () => {
    confirmRow.hidden = false;
    remove.hidden = true;
    save.hidden = true;
    guard.rearm();
    keep.focus();
  }, { "data-clover-key-remove": "" });
  const keep = guarded(t("key.keep"), guard, () => draw(view), { "data-clover-key-keep": "" });
  const really = guarded(t("key.remove"), guard, () => act("key.remove", {}, "key.removed"), { class: "clover-page__danger", "data-clover-key-remove-confirm": "" });
  // Keep comes first in the row; it is where focus goes, so a stray Enter keeps the key.
  confirmRow.append(el("span", {}, t("key.remove-ask")), keep, really);
  function draw(v: KeyView): void {
    view = v;
    state.textContent = v.set ? t("key.is-set", { label: v.label }) : t("key.not-set", { label: v.label });
    state.setAttribute("data-clover-key-state", v.set ? "set" : "unset");
    confirmRow.hidden = true;
    remove.hidden = !v.set;
    save.hidden = false;
    save.textContent = v.set ? t("key.replace") : t("key.save");
    guard.rearm();
    field.focus();
  }
  page.body.append(el("p", {}, t("key.intro", { plugin: view.plugin })), state, confirmRow, el("label", { class: "clover-page__field" }, view.label, field));
  page.actions.append(remove, save);
  draw(view);
}
