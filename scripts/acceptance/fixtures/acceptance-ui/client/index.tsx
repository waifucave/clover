// The acceptance run's third-party UI fixture: a page (the `main` spot, opened from its sidebar app button) that asks
// the core once (its own synced store's keys) and shows that it was answered, which opens its layer's own connection. TSX
// importing React and the UI SDK, with no react in the folder: each layer's import map serves them.
import { useEffect, useState } from "react";
import { usePluginApi, useT } from "@waifucave/clover-plugin-sdk/ui";

export function AcceptanceMain() {
  const api = usePluginApi();
  const t = useT();
  const [asked, setAsked] = useState("asking");
  const [pinged, setPinged] = useState(0);
  useEffect(() => {
    let live = true;
    // Its own synced store's keys (no capability needed): a real answer from the core on its layer's own connection.
    void api.storage.synced.keys().then(() => live && setAsked("asked"), (e: unknown) => live && setAsked(`refused: ${String(e).slice(0, 120)}`));
    // Its command `ping`, run by its key, tells the page.
    const off = api.host.on("pinged", (d) => setPinged(Number((d as { count?: unknown } | undefined)?.count ?? 0)));
    return () => {
      live = false;
      off();
    };
  }, [api]);
  return (
    <div data-acceptance-ui="main" data-asked={asked} data-pinged={pinged}>
      <p>Acceptance UI</p>
      <p data-acceptance-ui="hello">{t("acceptance-ui.hello")}</p>
    </div>
  );
}

/** The sidebar app entry's component (the sidebar draws its button from the entry's title and icon). */
export function AcceptanceBadge() {
  return <span data-acceptance-ui="badge">•</span>;
}
