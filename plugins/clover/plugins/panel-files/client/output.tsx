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
  header?: HTMLElement | null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
/** Only the session's outputs open here. */
const isOutput = (path: string) => /^home\/[^/]+\/\.clover\/outputs\/[^/]+\/[^/]+/.test(path) && !path.split("/").some((s) => s === ".." || s === ".");

function Header({ slot, children }: { slot: HTMLElement | null | undefined; children: ReactNode }) {
  return slot ? createPortal(<div className="cl-panel__head-own">{children}</div>, slot) : null;
}

export function OutputEntry({ props }: { props: OutputEntryProps }) {
  const files = usePluginApi().files;
  const path = props.path;
  const [shown, setShown] = useState<{ text?: string; image?: string; failed?: true } | undefined>(undefined);
  useEffect(() => {
    setShown(undefined);
    if (!files || !path || !isOutput(path)) return;
    let live = true;
    let url: string | undefined;
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
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [files, path]);
  if (!path) return null;
  const name = path.split("/").pop() ?? path;
  return (
    <div className="cl-files cl-files--output">
      <Header slot={props.header}>
        <span className="cl-files__title">{name}</span>
      </Header>
      {!isOutput(path) ? (
        <p className="cl-files__note">{S.outputOutside}</p>
      ) : !shown ? (
        <p className="cl-files__note" role="status">
          {S.loading}
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
