// The files on the runtime: the `panel` entry keyed `files`, for coding sessions only (`when.session: "coding"`). It
// shows the session's folder (its `root`, a tree path) and nothing outside it, through the plugin API's `files`: the
// computer that holds the folder serves it over the link, behind its own fence (lane J's `filesApiRoutes`; no mounts).
// Folders are listed as they open, a file is read when it opens, and `?word` searches inside files. It watches the
// folder (J's `filesWatch`): a change lists the folders it touched again and reads the open file again, and a resync
// lists every folder shown. The folder's name and its computer sit in the panel's header row.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FilesPanel, FilesTitle } from "./FilesPanel";
import type { FilesWithWatch } from "../../shell/runtime/types";
import { usePluginApi } from "./sdk";
import type { FileEntry } from "./types";

export interface FilesEntryProps {
  session?: string;
  header?: HTMLElement | null;
}

function Header({ slot, children }: { slot: HTMLElement | null | undefined; children: ReactNode }) {
  return slot ? createPortal(<div className="cl-panel__head-own">{children}</div>, slot) : null;
}

const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** Whether `path` is `root` or inside it: nothing outside the session's folder is listed or read. A `..` or `.`
 *  segment is never inside (review item 7), whatever it would resolve to. */
export const inside = (root: string, path: string) =>
  !path.split(/[\\/]/).some((s) => s === ".." || s === ".") && (path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`));

export function FilesEntry({ props }: { props: FilesEntryProps }) {
  const api = usePluginApi();
  const files = api.files as FilesWithWatch | undefined;
  const [where, setWhere] = useState<{ root: string; computer: string } | undefined>(undefined);
  const [listing, setListing] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<{ path: string; text: string } | undefined>(undefined);
  const [matches, setMatches] = useState<{ query: string; items: { path: string; line: number; text: string }[]; truncated?: boolean } | undefined>(undefined);

  const list = (path: string) => {
    if (!files || !where || !inside(where.root, path)) return;
    files.list(path).then(
      (stats) => setListing((l) => ({ ...l, [path]: stats.filter((s) => inside(where.root, s.path)).map((s) => ({ path: s.path, name: nameOf(s.path), type: s.type })) })),
      () => undefined,
    );
  };

  useEffect(() => {
    if (!props.session || !api.conversation?.get) return;
    let live = true;
    api.conversation.get(props.session).then(
      (s) => live && s.root && setWhere({ root: s.root, computer: s.computer }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, props.session]);

  useEffect(() => {
    if (where) list(where.root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where?.root]);

  // What the agent and the user change shows as it happens.
  const shown = useRef<{ listed: string[]; open?: string }>({ listed: [] });
  shown.current = { listed: Object.keys(listing), ...(open ? { open: open.path } : {}) };
  useEffect(() => {
    if (!files?.watch || !where) return;
    let stop: (() => void) | undefined;
    let live = true;
    const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const result = files.watch(where.root, (e) => {
      const { listed, open: openPath } = shown.current;
      const touched = e.type === "resync" ? listed : [...new Set(e.paths.flatMap((p) => [p, parent(p)]))].filter((p) => listed.includes(p));
      for (const folder of touched) list(folder);
      if (openPath && (e.type === "resync" || e.paths.includes(openPath))) files.readText(openPath).then((text) => setOpen({ path: openPath, text }), () => undefined);
    });
    void Promise.resolve(result).then((u) => (live ? (stop = u) : u()));
    return () => {
      live = false;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, where?.root]);

  if (!where) return null;
  return (
    <>
      <Header slot={props.header}>
        <FilesTitle root={where.root} computer={where.computer} />
      </Header>
      <FilesPanel
        root={where.root}
        listing={listing}
        onList={list}
        onOpen={(path) => {
          if (!files || !inside(where.root, path)) return;
          files.readText(path).then((text) => setOpen({ path, text }), () => undefined);
        }}
        {...(open ? { open } : {})}
        onSearch={(query) =>
          void files?.grep(query, { cwd: where.root, limit: 200 }).then(
            (r) => setMatches({ query, items: r.matches.filter((m) => inside(where.root, m.path)), ...(r.truncated ? { truncated: true } : {}) }),
            () => setMatches({ query, items: [] }),
          )
        }
        {...(matches ? { matches } : {})}
      />
    </>
  );
}
