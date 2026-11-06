// The files panel's client entry: `FilesEntry` fills `panel` keyed `files` on the runtime, in coding sessions only; the
// plain parts take mocked props. It imports no CSS: `client.css` lists the stylesheet (lane B).
export { FilesPanel, FilesTitle } from "./FilesPanel";
export { FilesEntry, inside, type FilesEntryProps } from "./entry";
export { FilePreview, previews, usePreviewPlugin, type FilePreviewProps } from "./preview";
export { visiblePaths } from "./filter";
export { TOKENS } from "./tokens";
export type * from "./types";
