// A lint for the theme CSS we ship (the base theme, Alpha's tab), holding it to spec §5.5's rules before
// the app's cleaner (lane E) ever sees it:
//
//   1. The cleaner's limits: no `@import`, and only the at-rules it keeps — @media, @supports, @container,
//      @scope, @starting-style, and the named ones (@keyframes, @font-face, @layer, @counter-style,
//      @font-palette-values). `@property` is dropped by the cleaner, so a theme must not rely on it.
//      Nothing loads from outside the plugin: a `url()` must RESOLVE, against a base inside the plugin, to
//      a file inside it (no scheme, no host, no escape out of the folder), and holds no `%` or `\`
//      escape; `image-set()`, `image()`, `element()`, `cross-fade()`, `src()` and a typed `attr()` are
//      refused outright; and no CSS escape stands outside a string, where it could spell `url(` or a
//      property this lint looks for.
//   2. Sealed approval frames stay visible: "every ancestor of a sealed frame stays free of filters,
//      opacity below 1 and transforms other than moves or enlargements, whatever a theme says". A theme
//      cannot know which element will hold a frame, so ours put no such effect — nor `visibility:
//      hidden`, nor a motion path that turns an element — on any ELEMENT at all; decoration that needs one
//      lives in pseudo-elements, which never contain a frame. An animation counts by what its keyframes
//      set.
//   3. Nothing is drawn over a frame: Chromium's check counts anything painted over it, even a
//      transparent box that ignores the pointer. So a theme keeps pseudo-elements in flow or beneath the
//      content (a negative z-index), takes no element out of flow, shifts or moves none, pulls none over
//      its neighbours with a negative margin, and lifts nothing with a positive z-index. A part's own stylesheet positions its layout, so it is checked
//      on the rendered part instead (`sealed-check.ts`), with `{ component: true }` here.
//
// Not a general CSS parser: comments, strings, parentheses, nesting and the at-rules above, which is all
// a theme of ours may use.

export const ALLOWED_AT_RULES: ReadonlySet<string> = new Set([
  "media",
  "supports",
  "container",
  "scope",
  "starting-style",
  "layer",
  "keyframes",
  "font-face",
  "counter-style",
  "font-palette-values",
]);

const GROUPING = new Set(["media", "supports", "container", "scope", "starting-style", "layer"]);

const PSEUDO_ELEMENT = /::(before|after|marker|placeholder|selection|backdrop|first-line|first-letter|file-selector-button|-webkit-scrollbar(-[a-z]+)?)(\([^)]*\))?\s*$/i;

export interface Declaration {
  property: string;
  value: string;
}

interface StyleRule {
  kind: "style";
  selectors: string[];
  declarations: Declaration[];
}

interface Keyframes {
  kind: "keyframes";
  name: string;
  declarations: Declaration[];
}

interface Statement {
  kind: "at";
  name: string;
  prelude: string;
}

type Item = StyleRule | Keyframes | Statement;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The index of the matching `}` for the `{` at `open`, skipping strings. */
function closeOf(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = endOfString(css, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error("an unclosed block");
}

function endOfString(css: string, start: number): number {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === "\\") i++;
    else if (css[i] === quote) return i;
  }
  throw new Error("an unclosed string");
}

/** The next `{` or `;` at depth 0 of parentheses, from `start`. */
function nextBoundary(css: string, start: number): number {
  let parens = 0;
  for (let i = start; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = endOfString(css, i);
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (parens === 0 && (c === "{" || c === ";" || c === "}")) return i;
  }
  return css.length;
}

function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of prelude) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function nest(parents: string[], child: string): string[] {
  const children = splitSelectors(child);
  if (parents.length === 0) return children;
  return parents.flatMap((p) => children.map((c) => (c.includes("&") ? c.replaceAll("&", p) : `${p} ${c}`)));
}

/** A block's own declarations, and the rules nested in it. */
function parseBlock(css: string, parents: string[], items: Item[]): Declaration[] {
  const declarations: Declaration[] = [];
  let i = 0;
  while (i < css.length) {
    const end = nextBoundary(css, i);
    const head = css.slice(i, end).trim();
    if (end >= css.length) {
      if (head) declarations.push(...toDeclaration(head));
      break;
    }
    if (css[end] === "{") {
      const close = closeOf(css, end);
      parseRule(head, css.slice(end + 1, close), parents, items);
      i = close + 1;
    } else {
      if (head) declarations.push(...toDeclaration(head));
      i = end + 1;
    }
  }
  return declarations;
}

function toDeclaration(text: string): Declaration[] {
  const colon = text.indexOf(":");
  if (colon < 0) return [];
  return [{ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim() }];
}

function parseRule(prelude: string, body: string, parents: string[], items: Item[]): void {
  if (prelude.startsWith("@")) {
    const name = /^@([a-z-]+)/i.exec(prelude)?.[1]?.toLowerCase() ?? "";
    const rest = prelude.slice(name.length + 1).trim();
    items.push({ kind: "at", name, prelude: rest });
    if (name === "keyframes") {
      // Keyframe selectors (from, to, 50%) each carry declarations; what matters is what any of them sets.
      const declarations: Declaration[] = [];
      for (const frame of body.matchAll(/\{([^{}]*)\}/g)) for (const line of frame[1]!.split(";")) declarations.push(...toDeclaration(line));
      items.push({ kind: "keyframes", name: rest, declarations });
    } else if (GROUPING.has(name)) {
      parseBlock(body, parents, items);
    }
    // Descriptor blocks (@font-face, @counter-style, @font-palette-values) hold descriptors, not styles;
    // their url()s are checked with every other url() in the file.
    return;
  }
  const selectors = nest(parents, prelude);
  const declarations = parseBlock(body, selectors, items);
  items.push({ kind: "style", selectors, declarations });
}

/** The style rules in a stylesheet, those inside @media, @supports and the like included (whatever their
 *  condition), nesting resolved. */
export function styleRules(css: string): { selectors: string[]; declarations: Declaration[] }[] {
  return parse(css).filter((item): item is StyleRule => item.kind === "style");
}

/** The @keyframes whose frames set something that would hide a sealed frame. */
export function hidingKeyframes(css: string): Set<string> {
  const names = new Set<string>();
  for (const item of parse(css)) if (item.kind === "keyframes" && item.declarations.some(hidesFrames)) names.add(item.name);
  return names;
}

/** Whether an `animation` or `animation-name` value runs one of `names`. */
export function animatesAny(value: string, names: ReadonlySet<string>): string | null {
  for (const name of names) if (new RegExp(`(^|[\\s,])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s,])`).test(value)) return name;
  return null;
}

function parse(css: string): Item[] {
  const items: Item[] = [];
  const text = stripComments(css);
  let i = 0;
  while (i < text.length) {
    const end = nextBoundary(text, i);
    const head = text.slice(i, end).trim();
    if (end >= text.length) break;
    if (text[end] === "{") {
      const close = closeOf(text, end);
      parseRule(head, text.slice(end + 1, close), [], items);
      i = close + 1;
    } else {
      if (head.startsWith("@")) {
        const name = /^@([a-z-]+)/i.exec(head)?.[1]?.toLowerCase() ?? "";
        items.push({ kind: "at", name, prelude: head.slice(name.length + 1).trim() });
      }
      i = end + 1;
    }
  }
  return items;
}

/** Whether a declaration would hide a sealed frame below the element it sits on. */
export function hidesFrames({ property, value }: Declaration): boolean {
  const v = value.toLowerCase().replace(/!important/, "").trim();
  switch (property) {
    case "filter":
    case "backdrop-filter":
    case "-webkit-backdrop-filter":
      return v !== "none";
    case "mask":
    case "mask-image":
    case "-webkit-mask":
    case "-webkit-mask-image":
    case "clip-path":
      return v !== "none";
    case "mix-blend-mode":
      return v !== "normal";
    case "visibility":
      return v === "hidden" || v === "collapse";
    case "content-visibility":
      return v === "hidden";
    // A motion path turns the element along it (`offset-rotate: auto`).
    case "offset":
    case "offset-path":
      return v !== "none";
    case "-webkit-box-reflect":
    case "mask-border":
    case "mask-border-source":
    case "-webkit-mask-box-image":
    case "-webkit-mask-box-image-source":
      return v !== "none";
    case "opacity": {
      const n = v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
      return !(n >= 1);
    }
    case "rotate":
      return v !== "none" && !/^0(deg|rad|turn)?$/.test(v);
    case "scale":
      return v !== "none" && v.split(/\s+/).some((part) => !(parseFloat(part) >= 1));
    case "transform":
      return !enlargesOrMoves(v);
    case "zoom":
      return !(parseFloat(v) >= 1);
    default:
      return false;
  }
}

/** `none`, or only translations and uniform enlargements. */
function enlargesOrMoves(v: string): boolean {
  if (v === "none") return true;
  const fns = [...v.matchAll(/([a-z0-9]+)\(([^)]*)\)/gi)];
  if (fns.length === 0) return false;
  return fns.every(([, fn, args]) => {
    const name = fn!.toLowerCase();
    if (name.startsWith("translate")) return true;
    if (name === "scale") {
      const parts = args!.split(",").map((a) => parseFloat(a));
      return parts.every((p) => p >= 1) && (parts.length === 1 || parts[0] === parts[1]);
    }
    return false;
  });
}

function isPseudoElementOnly(selectors: string[]): boolean {
  return selectors.length > 0 && selectors.every((s) => PSEUDO_ELEMENT.test(s));
}

/** The text with every string's contents blanked (its quotes kept), for searching outside strings. */
function blankStrings(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      let end: number;
      try {
        end = endOfString(css, i);
      } catch {
        end = css.length - 1;
      }
      out += c + " ".repeat(Math.max(0, end - i - 1)) + (end < css.length ? css[end] : "");
      i = end;
    } else out += c;
  }
  return out;
}

const PLUGIN_BASE = "https://plugin.invalid/root/";

function urlProblems(text: string, path: string): string[] {
  const problems: string[] = [];
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const base = new URL(folder, PLUGIN_BASE);
  for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = match[2]!.trim();
    let ok = target.length > 0 && !/[\\%\s]/.test(target) && !target.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(target);
    if (ok) {
      // Resolved, it must stay a file inside the plugin's folder.
      const resolved = new URL(target, base);
      ok = resolved.origin === new URL(PLUGIN_BASE).origin && resolved.pathname.startsWith("/root/") && resolved.pathname.length > "/root/".length && !resolved.pathname.endsWith("/");
    }
    if (!ok) problems.push(`url(${target}) is not a file inside the plugin`);
  }
  return problems;
}

/** Functions that load an image or a document by a string or from elsewhere: refused whatever they hold. */
const LOADERS = /(?<![\w-])(-webkit-)?(image-set|image|element|cross-fade|src)\s*\(/gi;
/** `attr()` typed as a url (CSS Values 5) loads too. */
const TYPED_ATTR = /(?<![\w-])attr\s*\(((?:[^()]|\([^()]*\))*)\)/gi;

function loaderProblems(blanked: string): string[] {
  const problems: string[] = [];
  for (const match of blanked.matchAll(LOADERS)) problems.push(`${match[0]!.replace(/\s+/g, "")}…) can load from outside the plugin; use url() with a file inside it`);
  for (const match of blanked.matchAll(TYPED_ATTR)) if (/\burl\b|type\s*\(/i.test(match[0]!)) problems.push(`${match[0]} can load a url; give attr() no url type`);
  return problems;
}

function escapeProblems(blanked: string): string[] {
  return blanked.includes("\\") ? ["a CSS escape (\\) outside a string could spell url( or a property; write it plainly"] : [];
}

const OUT_OF_FLOW = new Set(["absolute", "fixed", "sticky"]);
const OFFSETS = ["top", "right", "bottom", "left", "inset", "inset-block", "inset-inline", "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end"];

const clean = (value: string) => value.toLowerCase().replace(/!important/, "").trim();
function last(declarations: readonly Declaration[], property: string): string | undefined {
  for (let i = declarations.length - 1; i >= 0; i--) if (declarations[i]!.property === property) return clean(declarations[i]!.value);
  return undefined;
}

/** Whether a set of declarations, applied together, draws its box (or its pseudo-element's) over the content
 *  around it: out of flow, or shifted, unless a negative z-index puts it beneath. */
export function drawsOver(declarations: readonly Declaration[]): boolean {
  const position = last(declarations, "position");
  if (position === undefined) return false;
  const shifted = position === "relative" && OFFSETS.some((p) => {
    const v = last(declarations, p);
    return v !== undefined && !/^(auto|0(px|%|em|rem)?)( (auto|0(px|%|em|rem)?))*$/.test(v);
  });
  if (!OUT_OF_FLOW.has(position) && !shifted) return false;
  const z = last(declarations, "z-index");
  return !(z !== undefined && /^-\d+$/.test(z));
}

/** Whether declarations lift a box above the content around it: a positive z-index. */
export function lifts(declarations: readonly Declaration[]): boolean {
  const z = last(declarations, "z-index");
  return z !== undefined && /^\+?\d+$/.test(z) && Number(z) > 0;
}

const MARGINS = new Set(["margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-block", "margin-block-start", "margin-block-end", "margin-inline", "margin-inline-start", "margin-inline-end"]);

/** A margin that pulls the box over its neighbours (in flow, painted after them): a negative one, or one whose
 *  sign the lint cannot know (a variable, `env()`, `attr()` or a math function). The declaration, or null. */
export function pullsOver(declarations: readonly Declaration[]): string | null {
  for (const { property, value } of declarations) {
    if (!MARGINS.has(property)) continue;
    const v = clean(value);
    if (/(^|[\s(,*/])-\s*(\d|\.\d)/.test(v) || /\b(var|env|attr|calc|min|max|clamp|round|mod|rem|abs|sign)\s*\(/.test(v)) return `${property}: ${value}`;
  }
  return null;
}

/** Whether declarations move an element from where it is laid out. */
function moves(declarations: readonly Declaration[]): boolean {
  const translate = last(declarations, "translate");
  if (translate !== undefined && !/^(none|0(px|%)?( 0(px|%)?)*)$/.test(translate)) return true;
  const transform = last(declarations, "transform");
  return transform !== undefined && /translate/i.test(transform);
}

export interface CssCheckOptions {
  /** A part's own stylesheet (the island's, the pill's, the avatar's): its layout positions elements, so the
   *  overlap rule (3) is checked on the rendered part instead (`sealed-check.ts`). */
  component?: boolean;
  /** Where the file sits in its plugin (`theme.css`, `styles/tab.css`), for resolving its url()s. */
  path?: string;
}

/** Every problem in a theme's CSS (empty when there is none). */
export function checkThemeCss(css: string, options: CssCheckOptions = {}): string[] {
  const text = stripComments(css);
  const blanked = blankStrings(text);
  const problems: string[] = [...escapeProblems(blanked), ...urlProblems(text, options.path ?? "theme.css"), ...loaderProblems(blanked)];
  let items: Item[];
  try {
    items = parse(css);
  } catch (error) {
    return [...problems, `the CSS does not parse: ${(error as Error).message}`];
  }
  const hiding = new Set<string>();
  for (const item of items) {
    if (item.kind === "at") {
      if (!ALLOWED_AT_RULES.has(item.name)) problems.push(`@${item.name} is not an at-rule the cleaner keeps`);
    } else if (item.kind === "keyframes" && item.declarations.some(hidesFrames)) {
      hiding.add(item.name);
    }
  }
  for (const item of items) {
    if (item.kind !== "style") continue;
    const where = item.selectors.join(", ");
    const pseudo = isPseudoElementOnly(item.selectors);
    if (!options.component) {
      if (drawsOver(item.declarations)) {
        problems.push(
          pseudo
            ? `${where} is positioned over its element's content and could cover a sealed approval frame; keep it in flow, or beneath with a negative z-index`
            : `${where} takes an element out of flow or shifts it, over whatever lies there; that could cover a sealed approval frame`,
        );
      }
      if (lifts(item.declarations)) problems.push(`${where} { z-index: ${last(item.declarations, "z-index")} } lifts it over the content around it, which could cover a sealed approval frame`);
      if (!pseudo && moves(item.declarations)) problems.push(`${where} moves an element from its place, over whatever lies there; that could cover a sealed approval frame`);
      const pull = pullsOver(item.declarations);
      if (pull) problems.push(`${where} { ${pull} } could pull it over its neighbours, a sealed approval frame among them; keep margins zero or more, as plain lengths`);
    }
    if (pseudo) continue;
    for (const declaration of item.declarations) {
      if (hidesFrames(declaration)) {
        problems.push(`${where} { ${declaration.property}: ${declaration.value} } could hide a sealed approval frame`);
      }
      if (declaration.property === "animation" || declaration.property === "animation-name") {
        const name = animatesAny(declaration.value, hiding);
        if (name) problems.push(`${where} animates ${name}, whose keyframes could hide a sealed approval frame`);
      }
    }
  }
  return problems;
}
