// The changes on the runtime: the `panel` entry keyed `diff`, for coding sessions only (`when.session: "coding"`). It
// reads the session's diff from the core (`session.diff`: the working tree against HEAD in the session's folder, read
// only and bounded), and puts its base, its target and the layout switch in the panel's header row. A refusal shows as
// a line saying why, and an empty list as "No changes" with the core's notice (not a repository, another computer…).
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "./DiffPanel";
import { useCore } from "./sdk";
import { S } from "./strings";
import type { DiffFile, DiffLayout } from "./types";

export interface DiffEntryProps {
  session?: string;
  header?: HTMLElement | null;
  onOpenFile?: (path: string) => void;
}

function Header({ slot, children }: { slot: HTMLElement | null | undefined; children: ReactNode }) {
  return slot ? createPortal(<div className="cl-panel__head-own">{children}</div>, slot) : null;
}

export function DiffEntry({ props }: { props: DiffEntryProps }) {
  const core = useCore();
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<{ base: string; target: string; targets: string[]; files: DiffFile[]; notice?: string } | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!core || !props.session) return;
    let live = true;
    core.call("session.diff", { id: props.session, ...(target ? { target } : {}) }).then(
      (d) => {
        if (!live) return;
        setRefused(undefined);
        setDiff({ ...d, files: d.files as DiffFile[] });
      },
      (err: unknown) => live && setRefused(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [core, props.session, target]);

  if (refused !== undefined && !diff) {
    return (
      <div className="cl-diff">
        <div className="cl-diff__empty" role="status">{S.refused(refused)}</div>
      </div>
    );
  }
  if (!diff) return null;
  return (
    <>
      <Header slot={props.header}>
        {diff.base !== "" && <DiffTitle base={diff.base} target={diff.target} targets={diff.targets} onTarget={setTarget} />}
        <DiffLayoutSwitch layout={layout} onChange={setLayout} />
      </Header>
      <DiffPanel
        files={diff.files}
        layout={layout}
        {...(diff.files[0] ? { initialOpen: [diff.files[0].path] } : {})}
        {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
        {...(diff.notice ? { notice: diff.notice } : {})}
      />
    </>
  );
}
