// One of a session's outputs in the right panel (`panel` keyed `output`): what a bot or an agent made for the user to
// read, from the session's own `outputs/<session>` folder through the tree. An image shows as itself; anything else as
// its text, read only (a page's Markdown or HTML as source: nothing it holds runs here). Its name sits in the panel's
// header row.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePluginApi } from "./sdk";
import { S } from "./strings";

export interface OutputEntryProps {
  /** The output's tree path. */
  path?: string;
  /** Its session's outputs folder (the core's `SessionView.outputs`): only a file directly in it opens. */
  folder?: string;
  header?: HTMLElement | null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
/** Only a file directly in the session's outputs folder opens here; a `..` or `.` segment never does. */
const isOutput = (path: string, folder: string | undefined) => {
  if (!folder || path.split("/").some((s) => s === ".." || s === "." || s === "")) return false;
  const base = folder.replace(/\/+$/, "");
  return path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes("/");
};

function Header({ slot, children }: { slot: HTMLElement | null | undefined; children: ReactNode }) {
  return slot ? createPortal(<div className="cl-panel__head-own">{children}</div>, slot) : null;
}

export function OutputEntry({ props }: { props: OutputEntryProps }) {
  const files = usePluginApi().files;
  const path = props.path;
  const [shown, setShown] = useState<{ text?: string; image?: string; failed?: true; link?: true } | undefined>(undefined);
  useEffect(() => {
    setShown(undefined);
    if (!files || !path || !isOutput(path, props.folder)) return;
    let live = true;
    let url: string | undefined;
    const read = () => {
      if (IMAGE.test(path)) {
        files.readBytes(path).then(
          (bytes) => {
            if (!live) return;
            url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: TYPES[path.split(".").pop()!.toLowerCase()] }));
            setShown({ image: url });
          },
          () => live && setShown({ failed: true }),
        );
      } else {
        files.readText(path).then(
          (text) => live && setShown({ text }),
          () => live && setShown({ failed: true }),
        );
      }
    };
    // Only a plain file opens: the tree (lane J's) says what the path is, judging its real path, and a link a runner
    // left in its outputs is never followed, wherever it points (the controller's note).
    files.stat(path).then(
      (stat) => {
        if (!live) return;
        if (stat?.type === "file") read();
        else setShown(stat?.type === "symlink" ? { link: true } : { failed: true });
      },
      () => live && setShown({ failed: true }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [files, path, props.folder]);
  if (!path) return null;
  const name = path.split("/").pop() ?? path;
  return (
    <div className="cl-files cl-files--output">
      <Header slot={props.header}>
        <span className="cl-files__title">{name}</span>
      </Header>
      {!isOutput(path, props.folder) ? (
        <p className="cl-files__note">{S.outputOutside}</p>
      ) : !shown ? (
        <p className="cl-files__note" role="status">
          {S.loading}
        </p>
      ) : shown.link ? (
        <p className="cl-files__note" role="alert">
          {S.outputLink}
        </p>
      ) : shown.failed ? (
        <p className="cl-files__note" role="alert">
          {S.outputFailed}
        </p>
      ) : shown.image ? (
        <img className="cl-files__image" src={shown.image} alt={name} />
      ) : (
        <pre className="cl-files__code" aria-label={S.viewer(name)} tabIndex={0}>
          {shown.text}
        </pre>
      )}
    </div>
  );
}
