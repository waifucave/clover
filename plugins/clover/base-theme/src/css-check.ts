// A lint for the theme CSS we ship (the base theme, Alpha's tab), holding it to two of spec §5.5's rules
// before the app's cleaner (lane E) ever sees it:
//
//   1. The cleaner's limits: no `@import`, `url()` only for files inside the plugin (no scheme, no `..`),
//      and only the at-rules it keeps — @media, @supports, @container, @scope, @starting-style, and the
//      named ones (@keyframes, @font-face, @layer, @counter-style, @font-palette-values). `@property` is
//      dropped by the cleaner, so a theme must not rely on it.
//   2. Sealed approval frames stay visible: "every ancestor of a sealed frame stays free of filters,
//      opacity below 1 and transforms other than moves or enlargements, whatever a theme says". A theme
//      cannot know which element will hold a frame, so ours put no such effect on any ELEMENT at all —
//      decoration that needs one lives in pseudo-elements, which never contain a frame. An animation
//      counts by what its keyframes set.
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

function urlProblems(css: string): string[] {
  const problems: string[] = [];
  for (const match of stripComments(css).matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = match[2]!.trim();
    const ok =
      target.length > 0 &&
      !target.startsWith("/") &&
      !target.includes("\\") &&
      !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
      target.split("/").every((segment) => segment !== "..");
    if (!ok) problems.push(`url(${target}) is not a file inside the plugin`);
  }
  return problems;
}

/** Every problem in a theme's CSS (empty when there is none). */
export function checkThemeCss(css: string): string[] {
  const problems: string[] = [...urlProblems(css)];
  let items: Item[];
  try {
    items = parse(css);
  } catch (error) {
    return [...problems, `the CSS does not parse: ${(error as Error).message}`];
  }
  const hidingKeyframes = new Set<string>();
  for (const item of items) {
    if (item.kind === "at") {
      if (!ALLOWED_AT_RULES.has(item.name)) problems.push(`@${item.name} is not an at-rule the cleaner keeps`);
    } else if (item.kind === "keyframes" && item.declarations.some(hidesFrames)) {
      hidingKeyframes.add(item.name);
    }
  }
  for (const item of items) {
    if (item.kind !== "style" || isPseudoElementOnly(item.selectors)) continue;
    const where = item.selectors.join(", ");
    for (const declaration of item.declarations) {
      if (hidesFrames(declaration)) {
        problems.push(`${where} { ${declaration.property}: ${declaration.value} } could hide a sealed approval frame`);
      }
      if (declaration.property === "animation" || declaration.property === "animation-name") {
        for (const name of hidingKeyframes) {
          if (new RegExp(`(^|[\\s,])${name}($|[\\s,])`).test(declaration.value)) {
            problems.push(`${where} animates ${name}, whose keyframes could hide a sealed approval frame`);
          }
        }
      }
    }
  }
  return problems;
}
