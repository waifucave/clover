// The documents and headers the app serves on its own schemes (spec §5.5; spike S9's measured design, decision 94).
// Pure, so the headers are unit-tested.
//
//   clover-core://app/        the window's root: core code only, no plugin's
//   clover-plugin://<layer>/  one plugin layer's origin; `/?mount=<token>` is a frame's document (single use),
//                             `/_clover/…` the layer runtime (React, the UI API, the boot, the clover tree's bundle),
//                             `/_p/<plugin id>/…` that plugin's own files
//   clover-sealed://          sealed card frames (E-M3); refused until then
//   clover-web://<layer>/     a web page entry's folder page, served only in that plugin's own web session
//
// Every layer document and script carries a CSP that keeps it to its own origin, and `Connection-Allowlist`, which
// Chromium 156 enforces per document and worker, DNS lookups included: a document's lookups are matched against the
// list by host only (`HostOnlyMatch`), so the list never holds a `*` host. A script's list is `(response-origin)`; a
// document's also names each installed layer's origin by its label (`clover-plugin://<layer>/*`), because Chromium
// holds a child frame's navigation to its parent's list. So a document can look up only the installed layers' labels
// (the E-M1 review's B1; the app CI job's DNS-prefetch probe, with its positive control, checks it). Declared network
// hosts join both when lane B's registry hands them over; until then every layer is fail-closed (S9 item 7). The known
// gap stays (decision 94): a remote ICE candidate can still make a directly mounted document send checks to an
// undeclared address; the windows' `disable_non_proxied_udp` policy is the defence in depth.
import { createHash } from "node:crypto";

export const LAYER_SCHEME = "clover-plugin";
export const CORE_SCHEME = "clover-core";
export const SEALED_SCHEME = "clover-sealed";
/** A web page entry's folder page (§5.5 "Web pages"), in that plugin's own web session only. */
export const WEB_SCHEME = "clover-web";

/** What the layer runtime serves under `/_clover/`. */
export const RUNTIME_PATH = "/_clover/";

/** The bare specifiers every layer provides, each to the layer's one copy. */
export const IMPORT_MAP = {
  imports: {
    react: "/_clover/vendor/react.js",
    "react/jsx-runtime": "/_clover/vendor/react-jsx-runtime.js",
    "react/jsx-dev-runtime": "/_clover/vendor/react-jsx-runtime.js",
    "react-dom": "/_clover/vendor/react-dom.js",
    "react-dom/client": "/_clover/vendor/react-dom-client.js",
    "@waifucave/clover-plugin-sdk/ui": "/_clover/sdk-ui.js",
  },
} as const;

const IMPORT_MAP_TEXT = JSON.stringify(IMPORT_MAP);
const IMPORT_MAP_HASH = `'sha256-${createHash("sha256").update(IMPORT_MAP_TEXT).digest("base64")}'`;

/** The layer's own declared hosts (none until lane B's registry hands them over). Workers run only from the layer's
 *  own pages and in-bundle blobs (`worker-src 'self' blob:`, for the live2d decoder and its kind); scripts never come
 *  from a remote origin and never eval (`script-src 'self'` plus the import map's hash alone). */
export function layerCsp(hosts: readonly string[] = []): string {
  const net = hosts.join(" ");
  return [
    "default-src 'none'",
    `script-src 'self' ${IMPORT_MAP_HASH}`,
    // React sets styles through the CSSOM; some parts add a <style> element of their own.
    `style-src 'self' 'unsafe-inline'${net ? ` ${net}` : ""}`,
    `img-src 'self' data: blob:${net ? ` ${net}` : ""}`,
    `font-src 'self'${net ? ` ${net}` : ""}`,
    "media-src 'self' blob:",
    `connect-src 'self'${net ? ` ${net}` : ""}`,
    "worker-src 'self' blob:",
    // A part from another layer is a frame from that layer's origin; the core checks every frame's token and parent.
    // The sealed frames settle their card's fields and buttons (§5.5); a card is never on a web page.
    `frame-src ${LAYER_SCHEME}: ${SEALED_SCHEME}:`,
    `frame-ancestors ${CORE_SCHEME}: ${LAYER_SCHEME}:`,
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** A layer's origin label as the allowlist may name it: a plugin id's characters only, never a pattern. */
const LAYER_LABEL = /^[a-z0-9][a-z0-9-]*$/;

/** `Connection-Allowlist` for a layer document or script: its own origin and its declared hosts. A document also names
 *  each installed layer's origin (`layers`), from which it may load frames: Chromium 156 holds a frame's navigation to
 *  its parent's list (`ERR_NETWORK_ACCESS_REVOKED` otherwise), and each such frame is checked by its token, its parent
 *  and CSP. The sealed frames' own origin rides along always (E-M3): a part's sealed iframes navigate there, gated by
 *  their single-use tokens. Never a `*` host: the list also gates the document's DNS lookups, by host alone. */
export function connectionAllowlist(hosts: readonly string[] = [], layers: readonly string[] | undefined = undefined): string {
  const frames = (layers ?? []).filter((l) => LAYER_LABEL.test(l)).map((l) => JSON.stringify(`${LAYER_SCHEME}://${l}/*`));
  return `(${[...hosts.map((h) => JSON.stringify(`${h}/*`)), ...frames, JSON.stringify(`${SEALED_SCHEME}://card/*`), "response-origin"].join(" ")})`;
}

/** The sealed frames' own headers: the pages come from the app's own scheme, and their scripts and styles are
 *  inline-on with no network at all (§5.5: style tokens go in, nothing comes out), and the parents that may hold them
 *  are the core's own origins, never a web page. */
export function sealHeaders(): Readonly<Record<string, string>> {
  return { ...commonHeaders(), "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": sealCsp() };
}

const sealCsp = (): string => [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  `frame-ancestors ${CORE_SCHEME}: ${LAYER_SCHEME}:`,
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

export const CORE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `frame-src ${LAYER_SCHEME}:`,
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/** Headers every response on the app's schemes carries. */
export function commonHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), clipboard-read=()",
    "X-DNS-Prefetch-Control": "off",
  };
}

/** The headers of a response on a layer's origin. A document (`text/html`) names the installed layers it may frame. */
export function layerHeaders(contentType: string, hosts: readonly string[] = [], layers: readonly string[] = []): Record<string, string> {
  const h: Record<string, string> = { ...commonHeaders(), "Content-Type": contentType };
  const doc = contentType.startsWith("text/html");
  if (doc) h["Content-Security-Policy"] = layerCsp(hosts);
  if (doc || contentType.startsWith("text/javascript")) h["Connection-Allowlist"] = connectionAllowlist(hosts, doc ? layers : undefined);
  return h;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A frame's document: the import map, the layer's base styles, the plugin's stylesheets, and the boot. The mount
 *  token stays in the URL, where the preload reads it. */
export function layerDocument(input: { css: readonly string[]; title: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeAttr(input.title)}</title>`,
    `<script type="importmap">${IMPORT_MAP_TEXT}</script>`,
    '<link rel="stylesheet" href="/_clover/layer.css">',
    ...input.css.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`),
    '<script type="module" src="/_clover/boot.js"></script>',
    "</head>",
    '<body><div id="clover-root"></div></body>',
    "</html>",
  ].join("\n");
}
