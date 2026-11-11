// The acceptance run's third-party UI fixture: a page (the `main` spot, opened from its sidebar app button) that asks
// the core once (a read of its own settings, whatever it answers), which opens its layer's own connection. TSX
// importing React and the UI SDK, with no react in the folder: each layer's import map serves them.
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export function AcceptanceMain() {
  const api = usePluginApi();
  const [asked, setAsked] = useState("asking");
  useEffect(() => {
    let live = true;
    void api.settings.get("probe").then(() => live && setAsked("asked"), () => live && setAsked("asked"));
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
