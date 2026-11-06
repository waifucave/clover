// One of a session's outputs in the right panel (`panel` keyed `output`), beside the column that lists them. It is this
// part's because it declares `file.preview` for its own preview (the Files panel declares its own; one plugin declares
// a spot once): what a bot or an agent made for the user to
// read, from the session's own `outputs/<session>` folder through the tree. It is exactly one name in that folder
// (nothing nested, no `.` or `..`), and it is read in one no-follow call (lane J's `noFollow`, review N1): a link a
// runner left there, or swapped in, is never followed. Its preview is `file.preview`'s (a plugin's, keyed by its media
// type, in its own sealed part), else an image as itself and anything else as its text, read only (a page's Markdown
// or HTML as source: nothing it holds runs here), its hidden characters marked. Its name sits in the panel's header row.
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { directlyIn } from "../../shell/runtime/files";
import { FilePreview } from "./preview";
import { S } from "./strings";

export interface OutputEntryProps {
  /** The output's tree path. */
  path?: string;
  /** Its session's outputs folder: only a file directly in it opens. */
  folder?: string;
  header?: HTMLElement | null;
}

function Header({ slot, children }: { slot: HTMLElement | null | undefined; children: ReactNode }) {
  return slot ? createPortal(<div className="cl-panel__head-own">{children}</div>, slot) : null;
}

export function OutputEntry({ props }: { props: OutputEntryProps }) {
  const path = props.path;
  if (!path) return null;
  const name = path.split("/").pop() ?? path;
  return (
    <div className="cl-files cl-files--output">
      <Header slot={props.header}>
        <span className="cl-files__title">{name}</span>
      </Header>
      {directlyIn(path, props.folder) ? (
        <FilePreview path={path} linkNote={S.outputLink} failedNote={S.outputFailed} />
      ) : (
        <p className="cl-files__note">{S.outputOutside}</p>
      )}
    </div>
  );
}
