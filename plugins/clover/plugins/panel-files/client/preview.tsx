// A file's preview (`file.preview`, keyed by its media type: `image/png`, or a pattern a plugin fills such as
// `model/*`), in the output view and the Files panel. A plugin that fills the type draws it in its own sealed part, not
// in this one (lane E's frame), and gets only the path and the type: it reads the file through its own API, behind its
// own fence. The host hands it the path only once the tree's no-follow check says it is a plain file, the same check
// the output view reads with (review N1). With no plugin for the type, the host draws it itself, read in ONE
// no-follow call: an image as itself (never SVG), anything else as its text, its hidden characters marked (N6).
import { useEffect, useState, type ReactNode } from "react";
import { HOST_IMAGES, kindNoFollow, mediaTypeOf, readBytesNoFollow, readTextNoFollow } from "../../shell/runtime/files";
import { hasHidden, ShowHidden } from "./hidden";
import { Spot, usePluginApi, useSpotEntries } from "./sdk";
import { S } from "./strings";

export interface FilePreviewProps {
  path: string;
  /** What a link in place of the file says (the output view's own words). */
  linkNote?: string;
  /** What a file that can't be read says. */
  failedNote?: string;
}

type Shown = { plugin: true } | { text: string } | { image: string } | { link: true } | { failed: true };

/** Whether a plugin fills `file.preview` for this file's type here. */
export function usePreviewPlugin(path: string | undefined): boolean {
  const mediaType = path ? mediaTypeOf(path) : undefined;
  return useSpotEntries("file.preview", mediaType, path ? { path, mediaType } : {}).entries.length > 0;
}

/** Whether the host or a plugin previews this file (else it is text, for the code viewer). */
export const previews = (path: string, byPlugin: boolean) => byPlugin || HOST_IMAGES.has(mediaTypeOf(path));

export function FilePreview({ path, linkNote, failedNote }: FilePreviewProps) {
  const files = usePluginApi().files;
  const mediaType = mediaTypeOf(path);
  const byPlugin = usePreviewPlugin(path);
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  useEffect(() => {
    setShown(undefined);
    if (!files) return;
    let live = true;
    let url: string | undefined;
    const refused = () => void kindNoFollow(files, path).then((k) => live && setShown(k === "link" ? { link: true } : { failed: true }));
    if (byPlugin) {
      // What the path is, link or not, before a plugin is given it.
      void kindNoFollow(files, path).then((k) => live && setShown(k === "file" ? { plugin: true } : k === "link" ? { link: true } : { failed: true }));
    } else if (HOST_IMAGES.has(mediaType)) {
      readBytesNoFollow(files, path).then((bytes) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
        setShown({ image: url });
      }, refused);
    } else {
      readTextNoFollow(files, path).then((text) => live && setShown({ text }), refused);
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [files, path, mediaType, byPlugin]);

  const name = path.split("/").pop() ?? path;
  let body: ReactNode;
  if (!shown) {
    body = (
      <p className="cl-files__note" role="status">
        {S.opening}
      </p>
    );
  } else if ("link" in shown) {
    body = (
      <p className="cl-files__note" role="alert">
        {linkNote ?? S.previewLink}
      </p>
    );
  } else if ("failed" in shown) {
    body = (
      <p className="cl-files__note" role="alert">
        {failedNote ?? S.previewFailed}
      </p>
    );
  } else if ("plugin" in shown) {
    body = <Spot name="file.preview" spotKey={mediaType} props={{ path, mediaType }} />;
  } else if ("image" in shown) {
    body = <img className="cl-files__image" src={shown.image} alt={name} />;
  } else {
    body = (
      <>
        {hasHidden(shown.text) && <p className="cl-files__warning">{S.hiddenWarning}</p>}
        <pre className="cl-files__code" aria-label={S.viewer(name)} tabIndex={0}>
          <ShowHidden text={shown.text} />
        </pre>
      </>
    );
  }
  return (
    <div className="cl-files__preview" data-media-type={mediaType}>
      {body}
    </div>
  );
}
