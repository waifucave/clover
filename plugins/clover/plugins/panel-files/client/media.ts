// The media type a file's name says, for the files the panel hands to the `file.preview` spot instead of reading them as
// text: pictures, which a text read can't show. Anything else is read as text, as before.
const IMAGES: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
};

/** `image/*` for a picture's name, or undefined for a file the panel reads as text. */
export function previewTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 || path.lastIndexOf("/") > dot ? undefined : IMAGES[path.slice(dot + 1).toLowerCase()];
}
