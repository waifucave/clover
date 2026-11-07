// The browser module's own files besides the main bundle: the viewport page and its preload. The app's build
// (`apps/desktop/scripts/build.ts`, lane E/M) bundles and copies them as listed here, and hands their built paths to
// `createBrowserHost` (`assets`).
export const BROWSER_ASSETS = {
  /** Bundled to one CommonJS file: a sandboxed preload can't import. */
  preload: { entry: "src/main/browser/viewport-page/preload.ts", out: "out/main/browser-viewport-preload.cjs" },
  /** Copied as it is. */
  html: { from: "src/main/browser/viewport-page/viewport.html", out: "out/renderer/browser-viewport.html" },
  /** The streamed view's encoder page (`stream.ts`): its sandboxed preload, bundled like the viewport's… */
  streamPreload: { entry: "src/main/browser/stream-page/preload.ts", out: "out/main/browser-stream-preload.cjs" },
  /** …and its page, copied as it is. They go to `createBrowserHost` as `streamAssets`. */
  streamHtml: { from: "src/main/browser/stream-page/encoder.html", out: "out/renderer/browser-stream.html" },
} as const;
