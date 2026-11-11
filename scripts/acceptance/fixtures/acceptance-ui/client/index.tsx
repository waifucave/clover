// The acceptance run's UI fixture: a badge in the sidebar's app row that asks the core once (a read of its own
// settings, whatever it answers), which opens its layer's own connection; and a plain page.
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export function AcceptanceBadge() {
  const api = usePluginApi();
  const [asked, setAsked] = useState("asking");
  useEffect(() => {
    let live = true;
    void api.settings.get("probe").then(() => live && setAsked("asked"), () => live && setAsked("asked"));
    return () => {
      live = false;
    };
  }, [api]);
  return <span data-acceptance-ui="badge" data-asked={asked}>•</span>;
}

export function AcceptanceMain() {
  return <p data-acceptance-ui="main">Acceptance UI</p>;
}
