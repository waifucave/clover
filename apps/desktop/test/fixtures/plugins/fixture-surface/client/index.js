// A third-party surface for the app's tests: it sizes its window, says where it takes clicks, asks to show (a
// headless run never shows it), and asks the core for a menu, whose answer it draws.
import { jsx } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useMenu, useSurface } from "@waifucave/clover-plugin-sdk/ui";

export function FixtureSurface() {
  const surface = useSurface();
  const menu = useMenu();
  const [picked, setPicked] = useState("");
  useEffect(() => {
    surface({ width: 360, height: 120, regions: [{ x: 0, y: 0, width: 360, height: 40 }], visible: true });
    menu([{ id: "first", label: "First" }, { type: "separator" }, { id: "second", label: "Second" }], { x: 20, y: 10 })
      .then((id) => setPicked(id === null ? "none" : id), (err) => setPicked(`error: ${String(err && err.message)}`));
  }, []);
  return jsx("div", { "data-fixture": "surface", "data-menu": picked, children: picked === "" ? "Fixture surface" : `Menu: ${picked}` });
}
