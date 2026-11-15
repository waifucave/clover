// A third-party background part for the app's tests: it draws nothing a person sees.
import { jsx } from "react/jsx-runtime";

export function FixtureBackground() {
  return jsx("div", { "data-fixture": "background", children: "background" });
}
