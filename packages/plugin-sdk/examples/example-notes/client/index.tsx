// The Notes plugin's client half: the page (`main`, opened from the sidebar's Notes entry) and the sidebar entry's badge.
// React and the UI SDK come from the layer's import map: the plugin ships neither. The page reaches its plugin only
// through the UI SDK: its host half's `ui` table (`host.call("list")`, which goes over `plugin.layer.call`), its synced
// store's changes, and its own settings (`settings.watch`, which hears `plugin_settings_changed` for this plugin only;
// the order switch on the page writes its one setting with `settings.set`).
import { useCallback, useEffect, useState } from "react";
import { usePluginApi, useT } from "@waifucave/clover-plugin-sdk/ui";

interface Listed {
  notes: { text: string; at: number }[];
  turns: number;
}

type Order = "newest" | "oldest";

/** The notes and the order, kept current: read once, then again whenever the store or the order setting changes. */
function useNotes(): { listed: Listed | undefined; order: Order; setOrder(o: Order): void } {
  const api = usePluginApi();
  const [listed, setListed] = useState<Listed | undefined>(undefined);
  const [order, setOrder] = useState<Order>("newest");
  const reload = useCallback(() => {
    void api.host.call<Listed>("list").then(setListed, () => undefined);
  }, [api]);
  const readOrder = useCallback(() => {
    void api.settings.get<string>("order").then((v) => setOrder(v === "oldest" ? "oldest" : "newest"), () => undefined);
  }, [api]);
  useEffect(() => {
    reload();
    readOrder();
    const offStore = api.storage.synced.watch(() => reload());
    const offOrder = api.settings.watch("order", () => readOrder());
    return () => {
      offStore();
      offOrder();
    };
  }, [api, reload, readOrder]);
  // The page's own switch writes the setting; the page shows the new order only once the core says it changed
  // (`settings.watch` above), as it would after a change made anywhere else.
  const choose = useCallback((o: Order) => void api.settings.set("order", o).catch(() => undefined), [api]);
  return { listed, order, setOrder: choose };
}

const CSS = `
.np { padding: 28px 32px; max-width: 720px; font-family: var(--clover-font-family, system-ui, sans-serif); color: var(--clover-color-text, #2B2618); }
.np h1 { font-size: 24px; font-weight: 650; margin: 0 0 4px; }
.np__meta { color: var(--clover-color-text-muted, #6B6046); font-size: 13px; margin-bottom: 18px; display: flex; gap: 14px; }
.np ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.np li { background: var(--clover-color-surface, #FFFDF6); border: 1px solid var(--clover-color-hairline, #E9DDBA); border-radius: 12px; padding: 10px 14px; }
.np__order { font: inherit; color: var(--clover-color-accent-text, #8A5A12); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
.np time { display: block; font-size: 11.5px; color: var(--clover-color-text-muted, #6B6046); margin-top: 2px; }
.np__empty { color: var(--clover-color-text-muted, #6B6046); }
`;

export function NotesPage() {
  const t = useT();
  const { listed, order, setOrder } = useNotes();
  const notes = listed === undefined ? [] : [...listed.notes].sort((a, b) => (order === "newest" ? b.at - a.at : a.at - b.at));
  return (
    <main className="np" data-notes="page" data-order={order} data-turns={listed?.turns ?? ""} data-loaded={listed !== undefined}>
      <style>{CSS}</style>
      <h1>{t("example-notes.page.title")}</h1>
      <div className="np__meta">
        <span>{t("example-notes.page.count", { count: notes.length })}</span>
        <button type="button" className="np__order" data-notes="order" onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}>
          {t(order === "newest" ? "example-notes.page.order.newest" : "example-notes.page.order.oldest")}
        </button>
        <span data-notes="turns">{t("example-notes.page.turns", { turns: listed?.turns ?? 0 })}</span>
      </div>
      {listed !== undefined && notes.length === 0 ? <p className="np__empty">{t("example-notes.page.empty")}</p> : null}
      <ul>
        {notes.map((n) => (
          <li key={`${n.at}-${n.text}`} data-note={n.text}>
            {n.text}
            <time dateTime={new Date(n.at).toISOString()}>{new Date(n.at).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** The sidebar entry's badge: how many notes there are. */
export function NotesBadge() {
  const { listed } = useNotes();
  const n = listed?.notes.length ?? 0;
  return <span data-notes="badge" data-count={n}>{n > 0 ? n : ""}</span>;
}
