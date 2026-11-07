// A third-party part for the app's tests that hangs its layer's process on a mouse-down: it never returns. The window
// then goes unresponsive, the app pings each document in it, stops this layer's process (the only one that doesn't
// answer), and the core root shows its "stopped" note, with no restart into safe mode.
import { jsx } from "react/jsx-runtime";

export function Spin() {
  return jsx("div", {
    "data-fixture": "spin",
    style: { position: "fixed", inset: 0 },
    onMouseDown: () => {
      for (;;) {
        // Hung on purpose.
      }
    },
    children: "spin: ready",
  });
}
