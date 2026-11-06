// An attachment's preview through `file.preview` (keyed by its media type): a plugin that fills the type draws it in
// its own sealed part (lane E's frame), handed only the path and the type, and only once the tree's no-follow check
// says the path is a plain file (lane J's `noFollow`, review N1): a link is never handed on. Until then, and where no
// plugin fills the type, the view's own thumbnail shows.
import { useEffect, useState, type ReactNode } from "react";
import { kindNoFollow, mediaTypeOf } from "../../shell/runtime/files";
import { Spot, usePluginApi, useSpotEntries } from "./sdk";

export function FilePreview({ path, standard, at }: { path: string; standard: ReactNode; at: { bot: { id: string; name: string }; session: string } }) {
  const files = usePluginApi().files;
  const mediaType = mediaTypeOf(path);
  const byPlugin = useSpotEntries("file.preview", mediaType, { ...at, path, mediaType }).entries.length > 0;
  const [plain, setPlain] = useState(false);
  useEffect(() => {
    setPlain(false);
    if (!byPlugin || !files) return;
    let live = true;
    void kindNoFollow(files, path).then((k) => live && setPlain(k === "file"));
    return () => {
      live = false;
    };
  }, [files, path, byPlugin]);
  return byPlugin && plain ? <Spot name="file.preview" spotKey={mediaType} props={{ path, mediaType }} fallback={standard} /> : standard;
}
