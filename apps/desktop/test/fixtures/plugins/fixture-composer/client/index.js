// A third-party composer for the app's tests, as a plugin ships it: one built ES module that imports React and the UI
// API as bare specifiers, which its layer provides.
import { jsx, jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useMenu, useTokens } from "@waifucave/clover-plugin-sdk/ui";

export function FixtureComposer({ props }) {
  const tokens = useTokens();
  const [value, setValue] = useState("");
  const menu = useMenu();
  const [picked, setPicked] = useState("");
  // A menu from deep in the window (this frame sits in the shell's frame, in the root): the core places it by each
  // frame's place in the one around it. The core refuses a menu until the user has just clicked or pressed a key in
  // the window, so the fixture asks again until the test's input lets it through.
  useEffect(() => {
    let live = true;
    let timer;
    const ask = () => menu([{ id: "attach", label: "Attach" }], { x: 7, y: 5 }).then(
      (id) => live && setPicked(id === null ? "none" : id),
      () => { if (live) timer = setTimeout(ask, 300); },
    );
    ask();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  return jsxs("form", {
    className: "fixture-composer",
    "data-fixture": "composer",
    "data-bot": props.bot ? props.bot.id : "",
    "data-accent": String(tokens["color.accent"] ?? ""),
    "data-menu": picked,
    onSubmit: (e) => e.preventDefault(),
    children: [
      jsx("textarea", { "aria-label": `Message ${props.bot ? props.bot.name : ""}`, value, onChange: (e) => setValue(e.target.value) }),
      jsx("button", { type: "submit", children: "Send" }),
    ],
  });
}
