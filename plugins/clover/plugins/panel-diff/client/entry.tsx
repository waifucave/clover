// The changes on the runtime: the `panel` entry keyed `diff`, for coding sessions only (`when.session: "coding"`). It
// reads the session's diff from the core (`session.diff`, provisional: lane D's changes have no plugin-API call yet,
// so the `clover` layer asks the core), and puts its base, its target and the layout switch in the panel's header row.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "./DiffPanel";
import { useCore } from "./sdk";
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

  useEffect(() => {
    if (!core || !props.session) return;
    let live = true;
    core.call("session.diff", { id: props.session, ...(target ? { target } : {}) }).then(
      (d) => live && setDiff({ ...d, files: d.files as DiffFile[] }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [core, props.session, target]);

  if (!diff) return null;
  return (
    <>
      <Header slot={props.header}>
        <DiffTitle base={diff.base} target={diff.target} targets={diff.targets} onTarget={setTarget} />
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
