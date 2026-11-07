// The core's own pages, drawn in a window's root over whatever fills it (spec §5.8): the welcome setup guide (§3.3)
// and safe mode's plugin manager. Core code only, as the rest of the root: plain DOM, no plugin's, no inline styles
// (the root's CSP), and the daemon only through the main process's checked calls (`cloverRoot.call`). A key the user
// pastes goes from its field to that call and nowhere else: never stored here, never shown again, never logged.

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
  const list = el("div", { class: "clover-page__list" }, el("p", {}, t("welcome.loading")));
  page.body.append(list);
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
    list.replaceChildren(...providers.map((p) => provider(p)));
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
