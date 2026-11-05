// A third-party composer for the app's tests, as a plugin ships it: one built ES module that imports React and the UI
// API as bare specifiers, which its layer provides.
import { jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useTokens } from "@waifucave/clover-plugin-sdk/ui";

export function FixtureComposer({ props }) {
  const tokens = useTokens();
  const [value, setValue] = useState("");
  return jsxs("form", {
    className: "fixture-composer",
    "data-fixture": "composer",
    "data-bot": props.bot ? props.bot.id : "",
    "data-accent": String(tokens["color.accent"] ?? ""),
    onSubmit: (e) => e.preventDefault(),
    children: [
      jsx("textarea", { "aria-label": `Message ${props.bot ? props.bot.name : ""}`, value, onChange: (e) => setValue(e.target.value) }),
      jsx("button", { type: "submit", children: "Send" }),
    ],
  });
}
