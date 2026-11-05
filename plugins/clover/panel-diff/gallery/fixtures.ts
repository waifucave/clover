// A mocked set of changes: base against the working tree.
import type { DiffFile } from "../client/types";

export const FILES: DiffFile[] = [
  {
    path: "plugins/clover/panel/client/PanelToggles.tsx",
    status: "modified",
    added: 6,
    removed: 2,
    hunks: [
      {
        header: "@@ -21,9 +21,13 @@ export function PanelToggles",
        lines: [
          { kind: "context", old: 21, new: 21, text: "  return (" },
          { kind: "context", old: 22, new: 22, text: '    <div className="cl-panel-toggles">' },
          { kind: "del", old: 23, text: "      {PANEL_VIEWS.map((id) => {" },
          { kind: "del", old: 24, text: "        const pressed = open === id;" },
          { kind: "add", new: 23, text: "      {available.map((id) => {" },
          { kind: "add", new: 24, text: "        const Icon = ICONS[id];" },
          { kind: "add", new: 25, text: "        const pressed = open.includes(id);" },
          { kind: "context", old: 25, new: 26, text: "        return (" },
          { kind: "add", new: 27, text: "          // aria-pressed says whether its view is open" },
          { kind: "context", old: 26, new: 28, text: "          <button" },
          { kind: "add", new: 29, text: "            key={id}" },
          { kind: "add", new: 30, text: '            type="button"' },
          { kind: "context", old: 27, new: 31, text: '            className="cl-panel-toggle"' },
        ],
      },
    ],
  },
  { path: "plugins/clover/panel/client/SessionView.tsx", status: "added", added: 231, removed: 0, hunks: [{ header: "@@ -0,0 +1,231 @@", lines: [{ kind: "add", new: 1, text: "// The session column: what the session runs on and what it has made." }] }] },
  { path: "plugins/clover/shell/client/Sidebar.tsx", status: "modified", added: 412, removed: 339, tooLarge: true },
  { path: "plugins/clover/shell/gallery/composed.tsx", status: "deleted", added: 0, removed: 135, hunks: [{ header: "@@ -1,135 +0,0 @@", lines: [{ kind: "del", old: 1, text: "// The parts composed into a window." }] }] },
  { path: "plugins/clover/shell/gallery/screens.tsx", status: "renamed", from: "plugins/clover/shell/gallery/window.tsx", added: 12, removed: 4 },
  { path: "plugins/clover/shell/gallery/mark.png", status: "added", added: 0, removed: 0, binary: true },
];
