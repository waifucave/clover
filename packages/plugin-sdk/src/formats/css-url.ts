// What a plugin's CSS may load (spec §5.5: "`url()` only for files inside the folder, and no remote fonts or
// images"). The CSS cleaner (lane B) and the checks around sealed frames (lane E) apply this one rule. A lint over raw
// strings is not enough (`url(%2e%2e/…)`, `image-set("https://…")` and an escaped `u\72 l(` all pass one), so:
//
// 1. CSS is read with a CSS Syntax 3 tokenizer, so escapes are decoded before anything is compared: `u\72 l(` is
//    `url(`, and `\2e\2e/` is `../`. A function's name is compared after decoding, ignoring ASCII case
//    (`cssUnescape`, `cssFunctionName`).
// 2. Every function that loads something counts. `url()` and `src()` hold a URL, and so does every string inside
//    `image-set()` and `-webkit-image-set()` (`CSS_URL_FUNCTIONS`). `image()`, `cross-fade()` and `element()` are
//    dropped with the declaration that holds them (`CSS_DROPPED_FUNCTIONS`), as `@import` always is.
// 3. Each URL is resolved as a browser would resolve it, against the CSS file's own folder under an origin of the
//    plugin's own, and must keep that origin and stay inside the plugin's folder (`resolveCssUrl`). So `%2e%2e`,
//    backslashes, a leading `/` or `//`, and any scheme (`https:`, `data:`, `file:`) are refused, whatever their
//    spelling.
// 4. What the browser then loads is the core's asset URL for the resolved file, never the raw string.
// 5. A URL-taking function whose arguments hold `var()`, `env()` or `attr()` is dropped with its declaration
//    (`cssUrlArgumentsAreDynamic`, review S6): its URL is known only when the page computes it, so rule 3 can't see
//    it (`--u: "https://…"; background: image-set(var(--u))`).
// 6. Custom properties (`--x: …`) are scanned like any declaration: a URL function in one must pass rule 3, and a
//    dropped function drops it, though nothing loads until another declaration uses it.
import { treePathProblem } from "./tree-hash";

/** Functions whose argument is a URL, or whose strings are URLs (`image-set`). */
export const CSS_URL_FUNCTIONS: readonly string[] = ["url", "src", "image-set", "-webkit-image-set"];
/** Functions the cleaner drops with their declaration: they load or paint what the rule above can't check. */
export const CSS_DROPPED_FUNCTIONS: readonly string[] = ["image", "cross-fade", "-webkit-cross-fade", "element", "-moz-element", "expression"];

const HEX = /[0-9a-fA-F]/;
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

/** Decodes CSS escapes as CSS Syntax 3 does ("consume an escaped code point"): `\` and 1–6 hex digits, plus one
 *  whitespace after them, is that code point (U+FFFD for 0, a surrogate or one past U+10FFFF); `\` and a newline is
 *  dropped (a string's line continuation); `\` and any other character is that character; a lone `\` at the end is
 *  U+FFFD. */
export function cssUnescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    if (i + 1 >= text.length) {
      out += "�";
      break;
    }
    const next = text[i + 1]!;
    if (HEX.test(next)) {
      let j = i + 1;
      let hex = "";
      while (j < text.length && hex.length < 6 && HEX.test(text[j]!)) hex += text[j++]!;
      if (j < text.length && text[j] === "\r" && text[j + 1] === "\n") j += 2;
      else if (j < text.length && WHITESPACE.has(text[j]!)) j += 1;
      const cp = Number.parseInt(hex, 16);
      out += cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? "�" : String.fromCodePoint(cp);
      i = j - 1;
    } else if (next === "\n" || next === "\f") {
      i += 1;
    } else if (next === "\r") {
      i += text[i + 2] === "\n" ? 2 : 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

/** A function's name as the rule compares it: escapes decoded, ASCII lowercase. */
export function cssFunctionName(raw: string): string {
  return cssUnescape(raw).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function isCssUrlFunction(raw: string): boolean {
  return CSS_URL_FUNCTIONS.includes(cssFunctionName(raw));
}

export function isDroppedCssFunction(raw: string): boolean {
  return CSS_DROPPED_FUNCTIONS.includes(cssFunctionName(raw));
}

/** Functions whose value the page computes, so a URL built from them can't be checked. */
export const CSS_DYNAMIC_FUNCTIONS: readonly string[] = ["var", "env", "attr"];

/** Whether a URL-taking function's raw arguments hold `var()`, `env()` or `attr()`, however they are spelled
 *  (escapes decoded, any case): the cleaner then drops the declaration (rule 5). */
export function cssUrlArgumentsAreDynamic(rawArgs: string): boolean {
  const text = cssUnescape(rawArgs).replace(/[A-Z]/g, (c) => c.toLowerCase());
  return CSS_DYNAMIC_FUNCTIONS.some((name) => new RegExp(`(^|[^a-z0-9_\\-])${name}\\(`).test(text));
}

export type CssUrlVerdict =
  /** `path` is the file in the plugin's folder (as the tree hash names it); `suffix` is the query and fragment. */
  | { ok: true; path: string; suffix: string }
  | { ok: false; reason: string };

// A base no request ever reaches: the plugin's folder is `/__plugin__/` under an origin of its own.
const ORIGIN = "https://plugin.clover.invalid";
const ROOT = "/__plugin__/";

/** Resolves one URL from a plugin's CSS file (`cssFile`, a path in the plugin's folder) as a browser would, and keeps
 *  it only when it names a file inside the folder. `raw` is the URL as the tokenizer gives it: escapes decoded and
 *  quotes removed. */
export function resolveCssUrl(raw: string, cssFile: string): CssUrlVerdict {
  const value = raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  if (value === "") return { ok: false, reason: "an empty URL" };
  const fileProblem = treePathProblem(cssFile);
  if (fileProblem) return { ok: false, reason: `the CSS file's path has ${fileProblem}` };
  // A scheme, however it is spelled after the parser strips tabs and newlines, names another place.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/[\t\n\r]/g, ""))) {
    return { ok: false, reason: "a URL with a scheme; only files inside the plugin's folder load" };
  }
  const dir = cssFile.split("/").slice(0, -1).map((s) => `${encodeURIComponent(s)}/`).join("");
  let url: URL;
  try {
    url = new URL(value, `${ORIGIN}${ROOT}${dir}`);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.origin !== ORIGIN || url.username !== "" || url.password !== "") {
    return { ok: false, reason: "a URL that leaves the plugin's folder" };
  }
  if (!url.pathname.startsWith(ROOT)) {
    return { ok: false, reason: "a path that leaves the plugin's folder (a leading / or too many ..)" };
  }
  const segments: string[] = [];
  for (const seg of url.pathname.slice(ROOT.length).split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return { ok: false, reason: "a malformed %-escape" };
    }
    if (decoded.includes("/") || decoded.includes("\\")) return { ok: false, reason: "an escaped / or \\ in a path segment" };
    segments.push(decoded);
  }
  const path = segments.join("/");
  const problem = treePathProblem(path);
  if (problem) return { ok: false, reason: `a path with ${problem}` };
  return { ok: true, path, suffix: `${url.search}${url.hash}` };
}
