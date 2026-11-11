// The acceptance run's third-party UI fixture: a page (the `main` spot, opened from its sidebar app button) that asks
// the core once (its own synced store's keys) and shows that it was answered, which opens its layer's own connection. TSX
// importing React and the UI SDK, with no react in the folder: each layer's import map serves them.
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export function AcceptanceMain() {
  const api = usePluginApi();
  const [asked, setAsked] = useState("asking");
  useEffect(() => {
    let live = true;
    // Its own synced store's keys (no capability needed): a real answer from the core on its layer's own connection.
    void api.storage.synced.keys().then(() => live && setAsked("asked"), (e: unknown) => live && setAsked(`refused: ${String(e).slice(0, 120)}`));
    return () => {
      live = false;
    };
  }, [api]);
  return <p data-acceptance-ui="main" data-asked={asked}>Acceptance UI</p>;
}

/** The sidebar app entry's component (the sidebar draws its button from the entry's title and icon). */
export function AcceptanceBadge() {
  return <span data-acceptance-ui="badge">•</span>;
}
