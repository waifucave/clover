// The CSS cleaner (spec §5.5, plan §4 E-M2 "the theme engine"): what a theme's CSS, a style entry's, a layout's and
// the user's own overrides become before the core applies them in a layer. Pure, so every rule is unit-tested.
//
// * The CSS is read with a CSS Syntax 3 tokenizer, so escapes and comments can't hide anything from the rules below.
// * Only the at-rules the spec names are kept: `@media`, `@supports`, `@container`, `@scope`, `@starting-style`, and
//   the ones that define names, `@keyframes`, `@font-face`, `@layer`, `@counter-style` and `@font-palette-values`.
//   Everything else goes, `@import`, `@charset`, `@namespace`, `@property` and `@page` included.
// * The names those define are prefixed with the plugin's id (`clv-<id>__<name>`, the id's `/` written `_`, which no
//   id has, so two plugins' names never meet), and so are the plugin's own uses of them. A use of a name the plugin
//   didn't define (`system-ui`, a core keyframe) stays.
// * Every URL obeys lane B's rule (`resolveCssUrl`): a file inside the plugin's folder, resolved against the CSS file,
//   rewritten to the core's asset URL for it. A declaration with a URL that breaks the rule, a function that loads
//   what the rule can't check (`image()`, `element()`…), or a URL built from `var()`/`env()`/`attr()` is dropped.
// * The style rules are wrapped in `@scope (<the part>) to (<the parts inside it that another plugin dresses>)`, so
//   the CSS stops at the edge of a smaller part (§5.5); the defining at-rules stay outside, since their names are
//   global (and prefixed).
// * A layout's CSS also has its classes prefixed, as the layout's nodes are (`class: "card"` is `clv-<id>__card`).
import { cssFunctionName, cssUnescape, cssUrlArgumentsAreDynamic, isDroppedCssFunction, resolveCssUrl } from "@waifucave/clover-plugin-sdk";

// -------------------------------------------------------------------------------------------------
// Tokens
// -------------------------------------------------------------------------------------------------

export type TokKind =
  | "ws" | "ident" | "function" | "at" | "hash" | "string" | "bad-string" | "url" | "bad-url" | "delim"
  | "number" | "colon" | "semicolon" | "comma" | "[" | "]" | "(" | ")" | "{" | "}" | "cdo" | "cdc";

export interface Tok {
  kind: TokKind;
  /** The source text, as written. */
  raw: string;
  /** For ident, function (its name), at (its name), hash, string, url: the value with escapes decoded. */
  value: string;
}

const isNameStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isName = (c: string) => /[A-Za-z0-9_\-\u0080-￿]/.test(c);
const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);

/** CSS Syntax 3 tokenization. Comments are dropped (they never reach the output). */
export function tokenize(css: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = css.length;
  const at = (k: number) => (k < n ? css[k]! : "");
  const validEscape = (k: number) => at(k) === "\\" && at(k + 1) !== "\n" && at(k + 1) !== "";
  const startsIdent = (k: number) => {
    const c = at(k);
    if (c === "-") return isNameStart(at(k + 1)) || at(k + 1) === "-" || validEscape(k + 1);
    if (isNameStart(c)) return true;
    return validEscape(k);
  };
  const consumeEscape = (k: number): number => {
    // k at the backslash; returns the index after the escape.
    k++;
    if (isHex(at(k))) {
      let len = 0;
      while (len < 6 && isHex(at(k))) {
        k++;
        len++;
      }
      if (at(k) === "\r" && at(k + 1) === "\n") return k + 2;
      if (isWs(at(k))) return k + 1;
      return k;
    }
    return k + 1;
  };
  const consumeName = (k: number): number => {
    while (k < n) {
      if (isName(at(k))) k++;
      else if (validEscape(k)) k = consumeEscape(k);
      else break;
    }
    return k;
  };
  const consumeNumber = (k: number): number => {
    if (at(k) === "+" || at(k) === "-") k++;
    while (/[0-9]/.test(at(k))) k++;
    if (at(k) === "." && /[0-9]/.test(at(k + 1))) {
      k++;
      while (/[0-9]/.test(at(k))) k++;
    }
    if ((at(k) === "e" || at(k) === "E") && (/[0-9]/.test(at(k + 1)) || ((at(k + 1) === "+" || at(k + 1) === "-") && /[0-9]/.test(at(k + 2))))) {
      k += 2;
      while (/[0-9]/.test(at(k))) k++;
    }
    return k;
  };
  const startsNumber = (k: number) => {
    const c = at(k);
    if (/[0-9]/.test(c)) return true;
    if (c === ".") return /[0-9]/.test(at(k + 1));
    if (c === "+" || c === "-") return /[0-9]/.test(at(k + 1)) || (at(k + 1) === "." && /[0-9]/.test(at(k + 2)));
    return false;
  };
  const push = (kind: TokKind, start: number, end: number, value = "") => out.push({ kind, raw: css.slice(start, end), value });

  while (i < n) {
    const c = at(i);
    const start = i;
    if (c === "/" && at(i + 1) === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (isWs(c)) {
      while (isWs(at(i))) i++;
      push("ws", start, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let bad = false;
      while (i < n && at(i) !== c) {
        if (at(i) === "\n") {
          bad = true;
          break;
        }
        if (at(i) === "\\") {
          if (at(i + 1) === "") i++;
          else if (at(i + 1) === "\n") i += 2;
          else i = consumeEscape(i);
          continue;
        }
        i++;
      }
      if (!bad && at(i) === c) i++;
      const raw = css.slice(start, i);
      out.push({ kind: bad ? "bad-string" : "string", raw, value: bad ? "" : cssUnescape(raw.slice(1, raw.endsWith(c) && raw.length > 1 ? -1 : undefined)) });
      continue;
    }
    if (c === "#" && (isName(at(i + 1)) || validEscape(i + 1))) {
      i = consumeName(i + 1);
      push("hash", start, i, cssUnescape(css.slice(start + 1, i)));
      continue;
    }
    if (startsNumber(i)) {
      i = consumeNumber(i);
      if (startsIdent(i)) i = consumeName(i);
      else if (at(i) === "%") i++;
      push("number", start, i);
      continue;
    }
    if (c === "<" && css.startsWith("<!--", i)) {
      i += 4;
      push("cdo", start, i);
      continue;
    }
    if (c === "-" && css.startsWith("-->", i)) {
      i += 3;
      push("cdc", start, i);
      continue;
    }
    if (c === "@" && startsIdent(i + 1)) {
      i = consumeName(i + 1);
      push("at", start, i, cssUnescape(css.slice(start + 1, i)));
      continue;
    }
    if (startsIdent(i)) {
      i = consumeName(i);
      const name = cssUnescape(css.slice(start, i));
      if (at(i) === "(") {
        // url( with an unquoted argument is a url-token; with a quoted one, a function.
        if (name.toLowerCase() === "url") {
          let k = i + 1;
          while (isWs(at(k))) k++;
          if (at(k) !== '"' && at(k) !== "'") {
            let bad = false;
            while (k < n && at(k) !== ")") {
              if (at(k) === "\\") {
                if (validEscape(k)) k = consumeEscape(k);
                else {
                  bad = true;
                  k++;
                }
                continue;
              }
              if (at(k) === '"' || at(k) === "'" || at(k) === "(") bad = true;
              k++;
            }
            if (at(k) === ")") k++;
            const raw = css.slice(start, k);
            const inner = raw.slice(raw.indexOf("(") + 1, raw.endsWith(")") ? -1 : undefined).trim();
            out.push({ kind: bad ? "bad-url" : "url", raw, value: bad ? "" : cssUnescape(inner) });
            i = k;
            continue;
          }
        }
        i++;
        push("function", start, i, name);
        continue;
      }
      push("ident", start, i, name);
      continue;
    }
    i++;
    const single: Record<string, TokKind> = { ":": "colon", ";": "semicolon", ",": "comma", "[": "[", "]": "]", "(": "(", ")": ")", "{": "{", "}": "}" };
    if (c === "\\") {
      // An escape that can't start an ident (a backslash before a newline): a delim, as the spec says.
      push("delim", start, i, c);
      continue;
    }
    push(single[c] ?? "delim", start, i, c);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The tree
// -------------------------------------------------------------------------------------------------

export interface Decl { kind: "decl"; name: string; raw: string; value: Tok[]; important: boolean }
export interface QRule { kind: "rule"; prelude: Tok[]; body: Item[] }
export interface AtRule { kind: "at"; name: string; prelude: Tok[]; body?: Item[] }
export type Item = Decl | QRule | AtRule;

/** The tokens of a `{}` block from `i` (just past its `{`), to its matching `}`; returns them and the index after it. */
function block(toks: Tok[], i: number): [Tok[], number] {
  let depth = 0;
  const start = i;
  for (; i < toks.length; i++) {
    const k = toks[i]!.kind;
    if (k === "{" || k === "(" || k === "[" || k === "function") depth++;
    else if (k === "}" || k === ")" || k === "]") {
      if (depth === 0 && k === "}") return [toks.slice(start, i), i + 1];
      depth = Math.max(0, depth - 1);
    }
  }
  return [toks.slice(start), toks.length];
}

/** Parses a block's contents (or a whole sheet): declarations, style rules and at-rules, nesting included. */
export function parseItems(toks: Tok[]): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.kind === "ws" || t.kind === "semicolon" || t.kind === "cdo" || t.kind === "cdc") {
      i++;
      continue;
    }
    if (t.kind === "at") {
      // An at-rule: its prelude to a `;` or a `{` block.
      let j = i + 1;
      let depth = 0;
      while (j < toks.length) {
        const k = toks[j]!.kind;
        if (depth === 0 && (k === "semicolon" || k === "{" || k === "}")) break;
        if (k === "(" || k === "[" || k === "function") depth++;
        if (k === ")" || k === "]") depth = Math.max(0, depth - 1);
        j++;
      }
      const prelude = toks.slice(i + 1, j);
      if (j < toks.length && toks[j]!.kind === "{") {
        const [inner, next] = block(toks, j + 1);
        items.push({ kind: "at", name: t.value.toLowerCase(), prelude, body: parseItems(inner) });
        i = next;
      } else {
        items.push({ kind: "at", name: t.value.toLowerCase(), prelude });
        i = j < toks.length && toks[j]!.kind === "semicolon" ? j + 1 : j;
      }
      continue;
    }
    // A declaration (to the next top-level `;` or the end), unless a `{` comes first: then a nested style rule.
    let j = i;
    let depth = 0;
    let braceFirst = false;
    const custom = t.kind === "ident" && t.value.startsWith("--");
    while (j < toks.length) {
      const k = toks[j]!.kind;
      if (depth === 0 && k === "semicolon") break;
      if (depth === 0 && k === "}") break;
      if (depth === 0 && k === "{" && !custom) {
        braceFirst = true;
        break;
      }
      if (k === "(" || k === "[" || k === "function" || k === "{") depth++;
      if (k === ")" || k === "]" || k === "}") depth = Math.max(0, depth - 1);
      j++;
    }
    if (braceFirst) {
      const [inner, next] = block(toks, j + 1);
      items.push({ kind: "rule", prelude: toks.slice(i, j), body: parseItems(inner) });
      i = next;
      continue;
    }
    const d = declaration(toks.slice(i, j));
    if (d !== undefined) items.push(d);
    i = j < toks.length && toks[j]!.kind === "semicolon" ? j + 1 : j + 1;
  }
  return items;
}

function declaration(toks: Tok[]): Decl | undefined {
  const t = toks.filter((x) => x.kind !== "ws");
  if (t.length < 2 || t[0]!.kind !== "ident" || t[1]!.kind !== "colon") return undefined;
  const colon = toks.indexOf(t[1]!);
  let value = toks.slice(colon + 1);
  let important = false;
  const sig = value.filter((x) => x.kind !== "ws");
  if (sig.length >= 2 && sig[sig.length - 2]!.kind === "delim" && sig[sig.length - 2]!.value === "!" && sig[sig.length - 1]!.kind === "ident" && sig[sig.length - 1]!.value.toLowerCase() === "important") {
    important = true;
    value = value.slice(0, value.lastIndexOf(sig[sig.length - 2]!));
  }
  return { kind: "decl", name: t[0]!.value.startsWith("--") ? t[0]!.value : t[0]!.value.toLowerCase(), raw: t[0]!.raw, value, important };
}

// -------------------------------------------------------------------------------------------------
// The cleaner
// -------------------------------------------------------------------------------------------------

/** The at-rules kept (§5.5); every other one is dropped. */
export const KEPT_AT_RULES = ["media", "supports", "container", "scope", "starting-style", "keyframes", "font-face", "layer", "counter-style", "font-palette-values"] as const;
const GROUPS = new Set(["media", "supports", "container", "layer", "scope", "starting-style"]);
const DEFINING = new Set(["keyframes", "font-face", "counter-style", "font-palette-values"]);

export interface CleanOptions {
  /** The plugin whose CSS this is: its id prefixes the names it defines. */
  pluginId: string;
  /** The CSS file's path in the plugin's folder, which its URLs resolve against; undefined for the user's own CSS,
   *  which may load nothing. */
  file?: string;
  /** The core's URL for a file of the plugin's (a path in its folder). */
  assetUrl?: (path: string) => string;
  /** Wraps the style rules: `@scope (<root>) to (<limit>)`. */
  scope?: { root: string; limit?: string };
  /** A layout's CSS: its classes are prefixed too. */
  prefixClasses?: boolean;
  /** Font families the plugin defines outside this file (a theme's `fonts`), prefixed like `@font-face`'s. */
  fontFamilies?: readonly string[];
}

export interface Cleaned {
  css: string;
  /** What was dropped and why, for the plugin's log (never shown to anyone else). */
  dropped: string[];
}

/** The prefix for a plugin's names: `clv-<id>__`, its `/` written `_`. */
export function namePrefix(pluginId: string): string {
  return `clv-${pluginId.replace(/\//g, "_")}__`;
}

/** A plugin's class, as a layout's node and its cleaned CSS both write it. */
export function prefixedClass(pluginId: string, name: string): string {
  return `${namePrefix(pluginId)}${name}`;
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c.codePointAt(0)!.toString(16)} `);
const str = (s: string) => `"${s.replace(/["\\\n]/g, (c) => (c === "\n" ? "\\a " : `\\${c}`))}"`;

interface Defined {
  keyframes: Set<string>;
  fonts: Set<string>;
  counters: Set<string>;
  palettes: Set<string>;
  layers: Set<string>;
}

function collect(items: Item[], d: Defined): void {
  for (const it of items) {
    if (it.kind !== "at") {
      if (it.kind === "rule") collect(it.body, d);
      continue;
    }
    const first = it.prelude.find((t) => t.kind !== "ws");
    if (it.name === "keyframes" && first !== undefined && (first.kind === "ident" || first.kind === "string")) d.keyframes.add(first.value);
    if (it.name === "counter-style" && first?.kind === "ident") d.counters.add(first.value);
    if (it.name === "font-palette-values" && first?.kind === "ident" && first.value.startsWith("--")) d.palettes.add(first.value);
    if (it.name === "font-face") {
      for (const b of it.body ?? []) if (b.kind === "decl" && b.name === "font-family") {
        const fam = familyName(b.value.filter((t) => t.kind !== "ws"));
        if (fam !== undefined) d.fonts.add(fam);
      }
    }
    if (it.name === "layer") for (const t of it.prelude) if (t.kind === "ident") d.layers.add(t.value);
    if (it.body !== undefined) collect(it.body, d);
  }
}

/** A family name written as one string or a run of idents; undefined for anything else. */
function familyName(t: Tok[]): string | undefined {
  if (t.length === 1 && t[0]!.kind === "string") return t[0]!.value;
  if (t.length > 0 && t.every((x) => x.kind === "ident")) return t.map((x) => x.value).join(" ");
  return undefined;
}

export function cleanCss(css: string, opts: CleanOptions): Cleaned {
  const dropped: string[] = [];
  const items = parseItems(tokenize(css));
  const defined: Defined = { keyframes: new Set(), fonts: new Set(opts.fontFamilies ?? []), counters: new Set(), palettes: new Set(), layers: new Set() };
  collect(items, defined);
  const prefix = namePrefix(opts.pluginId);
  const p = (name: string) => `${prefix}${name}`;

  // ---- values ----
  const urlOf = (raw: string): string | undefined => {
    if (opts.file === undefined || opts.assetUrl === undefined) return undefined;
    const v = resolveCssUrl(raw, opts.file);
    return v.ok ? opts.assetUrl(v.path) + v.suffix : undefined;
  };
  /** A declaration's value, rewritten; undefined when the declaration must go. */
  const value = (toks: Tok[], prop: string): string | undefined => {
    let out = "";
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind === "bad-url" || t.kind === "bad-string") return undefined;
      if (t.kind === "url") {
        const u = urlOf(t.value);
        if (u === undefined) return void dropped.push(`a url() that leaves the plugin's folder (${prop})`);
        out += `url(${str(u)})`;
        continue;
      }
      if (t.kind === "function") {
        const name = cssFunctionName(t.value);
        const [args, end] = parens(toks, i + 1);
        if (isDroppedCssFunction(t.value)) return void dropped.push(`${name}() (${prop})`);
        if (name === "url" || name === "src" || name === "image-set" || name === "-webkit-image-set") {
          if (cssUrlArgumentsAreDynamic(args.map((a) => a.raw).join(""))) return void dropped.push(`${name}() built from var(), env() or attr() (${prop})`);
          let inner = "";
          for (const a of args) {
            if (a.kind === "string") {
              const u = urlOf(a.value);
              if (u === undefined) return void dropped.push(`a URL in ${name}() that leaves the plugin's folder (${prop})`);
              inner += str(u);
            } else if (a.kind === "url") {
              const u = urlOf(a.value);
              if (u === undefined) return void dropped.push(`a URL in ${name}() that leaves the plugin's folder (${prop})`);
              inner += `url(${str(u)})`;
            } else if (a.kind === "function") {
              // A function inside image-set (type(), a nested image-set): checked like any other.
              const sub = value([a, ...args.slice(args.indexOf(a) + 1)], prop);
              if (sub === undefined) return undefined;
              inner += sub;
              break;
            } else inner += a.raw;
          }
          out += `${name}(${inner})`;
          i = end;
          continue;
        }
        if ((name === "counter" || name === "counters") && args.length > 0) {
          const sub = names(args, defined.counters, p);
          out += `${t.raw}${sub})`;
          i = end;
          continue;
        }
        const sub = value(args, prop);
        if (sub === undefined) return undefined;
        out += `${t.raw}${sub})`;
        i = end;
        continue;
      }
      out += t.raw;
    }
    return out;
  };
  const decl = (d: Decl, inFontFace: boolean): string | undefined => {
    let v: string | undefined;
    const sig = d.value.filter((t) => t.kind !== "ws");
    if (inFontFace && d.name === "font-family") {
      const fam = familyName(sig);
      v = fam === undefined ? undefined : str(p(fam));
    } else if (d.name === "font-family" || d.name === "font") {
      v = families(d.value, defined.fonts, p, d.name === "font", (toks) => value(toks, d.name));
    } else if (d.name === "animation-name" || d.name === "animation") {
      v = renameIdents(d.value, defined.keyframes, p, (toks) => value(toks, d.name));
    } else if (d.name === "list-style-type" || d.name === "list-style" || d.name === "system" || d.name === "fallback") {
      v = renameIdents(d.value, defined.counters, p, (toks) => value(toks, d.name));
    } else if (d.name === "font-palette") {
      v = renameIdents(d.value, defined.palettes, (n) => (n.startsWith("--") ? `--${prefix}${n.slice(2)}` : n), (toks) => value(toks, d.name));
    } else {
      v = value(d.value, d.name);
    }
    if (v === undefined) return undefined;
    return `${d.raw}:${v.trim()}${d.important ? " !important" : ""}`;
  };

  // ---- rules ----
  const selector = (toks: Tok[]): string => {
    if (opts.prefixClasses !== true) return toks.map((t) => t.raw).join("").trim();
    let s = "";
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind === "delim" && t.value === "." && toks[i + 1]?.kind === "ident") {
        s += `.${ident(p(toks[i + 1]!.value))}`;
        i++;
        continue;
      }
      s += t.raw;
    }
    return s.trim();
  };
  const body = (list: Item[], ctx: "style" | "font-face" | "descriptors" | "keyframes"): string => {
    // Declarations end with `;` (the last one needn't); rules stand as they are.
    const parts: { text: string; decl: boolean }[] = [];
    for (const it of list) {
      if (it.kind === "decl") {
        const out = decl(it, ctx === "font-face");
        if (out !== undefined) parts.push({ text: out, decl: true });
        continue;
      }
      if (ctx === "keyframes" && it.kind === "rule") {
        parts.push({ text: `${it.prelude.map((t) => t.raw).join("").trim()}{${body(it.body, "style")}}`, decl: false });
        continue;
      }
      if (ctx === "font-face" || ctx === "descriptors") continue;
      const r = rule(it, true);
      if (r !== "") parts.push({ text: r, decl: false });
    }
    return parts.map((x, i) => (x.decl && i < parts.length - 1 ? `${x.text};` : x.text)).join("");
  };
  /** One rule. `nested`: inside a style rule or a group, where the scope wrapper already holds. */
  const rule = (it: QRule | AtRule, nested: boolean): string => {
    if (it.kind === "rule") return `${selector(it.prelude)}{${body(it.body, "style")}}`;
    if (!(KEPT_AT_RULES as readonly string[]).includes(it.name)) {
      dropped.push(`@${it.name}`);
      return "";
    }
    if (it.name === "keyframes") {
      const first = it.prelude.find((t) => t.kind !== "ws");
      if (first === undefined || (first.kind !== "ident" && first.kind !== "string")) return "";
      return `@keyframes ${ident(p(first.value))}{${body(it.body ?? [], "keyframes")}}`;
    }
    if (it.name === "font-face") return `@font-face{${body(it.body ?? [], "font-face")}}`;
    if (it.name === "counter-style") {
      const first = it.prelude.find((t) => t.kind !== "ws");
      if (first?.kind !== "ident") return "";
      return `@counter-style ${ident(p(first.value))}{${body(it.body ?? [], "descriptors")}}`;
    }
    if (it.name === "font-palette-values") {
      const first = it.prelude.find((t) => t.kind !== "ws");
      if (first?.kind !== "ident" || !first.value.startsWith("--")) return "";
      return `@font-palette-values --${ident(`${prefix}${first.value.slice(2)}`)}{${body(it.body ?? [], "descriptors")}}`;
    }
    if (it.name === "layer") {
      const prelude = it.prelude.map((t) => (t.kind === "ident" && !/^\./.test(t.raw) ? ident(p(t.value)) : t.raw)).join("").trim();
      if (it.body === undefined) return `@layer ${prelude};`;
      return `@layer ${prelude}{${groupBody(it.body, nested)}}`;
    }
    // @media, @supports, @container, @scope, @starting-style: their prelude as written (a @scope's selectors
    // prefixed like any selector), their contents cleaned.
    const prelude = it.name === "scope" ? selector(it.prelude) : it.prelude.map((t) => t.raw).join("").trim();
    const inner = it.name === "scope" || it.name === "starting-style" ? body(it.body ?? [], "style") : groupBody(it.body ?? [], nested);
    return `@${it.name} ${prelude}{${inner}}`;
  };
  /** A group's contents: its style rules wrapped in the scope unless already inside it. */
  const groupBody = (list: Item[], nested: boolean): string => (nested ? body(list, "style") : sheet(list));
  const wrap = (css: string) => {
    if (opts.scope === undefined || css === "") return css;
    return `@scope (${opts.scope.root})${opts.scope.limit !== undefined ? ` to (${opts.scope.limit})` : ""}{${css}}`;
  };
  /** A list at the top (or in a group at the top): defining at-rules as they are, runs of style rules wrapped. */
  const sheet = (list: Item[]): string => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length > 0) out.push(wrap(run.join("")));
      run = [];
    };
    for (const it of list) {
      if (it.kind === "decl") {
        dropped.push(`a declaration outside any rule (${it.name})`);
        continue;
      }
      if (it.kind === "at" && (DEFINING.has(it.name) || (it.name === "layer" && it.body === undefined))) {
        flush();
        const r = rule(it, false);
        if (r !== "") out.push(r);
        continue;
      }
      if (it.kind === "at" && GROUPS.has(it.name) && it.name !== "scope" && it.name !== "starting-style") {
        flush();
        const r = rule(it, false);
        if (r !== "") out.push(r);
        continue;
      }
      const r = rule(it, false);
      if (r !== "") run.push(r);
    }
    flush();
    return out.join("\n");
  };
  return { css: sheet(items), dropped };
}

/** The tokens inside a function's parentheses from `i` (just past its opening), and the index of its `)`. */
function parens(toks: Tok[], i: number): [Tok[], number] {
  let depth = 0;
  const start = i;
  for (; i < toks.length; i++) {
    const k = toks[i]!.kind;
    if (k === "function" || k === "(") depth++;
    else if (k === ")") {
      if (depth === 0) return [toks.slice(start, i), i];
      depth--;
    }
  }
  return [toks.slice(start), toks.length - 1];
}

/** Rewrites the idents in a value that the plugin defined (keyframes, counter styles, palettes), leaving the rest of
 *  the value to `rest` (URLs, functions). */
function renameIdents(toks: Tok[], defined: ReadonlySet<string>, rename: (n: string) => string, rest: (toks: Tok[]) => string | undefined): string | undefined {
  const swapped = toks.map((t) => (t.kind === "ident" && defined.has(t.value) ? { ...t, raw: ident(rename(t.value)) } : t.kind === "string" && defined.has(t.value) ? { ...t, kind: "ident" as const, raw: ident(rename(t.value)) } : t));
  return rest(swapped);
}

/** `counter(name, style)` / `counters(name, sep, style)`: the style (the last ident) is a counter style's name. */
function names(args: Tok[], defined: ReadonlySet<string>, rename: (n: string) => string): string {
  return args.map((t) => (t.kind === "ident" && defined.has(t.value) ? ident(rename(t.value)) : t.raw)).join("");
}

/** A family list (`font-family`, or the end of the `font` shorthand): each family the plugin defined is written as its
 *  prefixed name, quoted. */
function families(toks: Tok[], defined: ReadonlySet<string>, rename: (n: string) => string, shorthand: boolean, rest: (toks: Tok[]) => string | undefined): string | undefined {
  // Split at top-level commas.
  const groups: Tok[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.kind === "function" || t.kind === "(") depth++;
    if (t.kind === ")") depth--;
    if (t.kind === "comma" && depth === 0) groups.push([]);
    else groups[groups.length - 1]!.push(t);
  }
  const out: string[] = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const sig = group.filter((t) => t.kind !== "ws");
    // The family is the whole group, or in `font`'s first group, its trailing string or idents.
    let famStart = 0;
    if (shorthand && g === 0) {
      let k = sig.length;
      if (k > 0 && sig[k - 1]!.kind === "string") k--;
      else while (k > 0 && sig[k - 1]!.kind === "ident") k--;
      famStart = k;
    }
    const fam = familyName(sig.slice(famStart));
    if (fam !== undefined && defined.has(fam)) {
      const head = rest(group.slice(0, famStart === 0 ? 0 : group.indexOf(sig[famStart]!)));
      if (head === undefined) return undefined;
      out.push(`${head.trim()}${head.trim() === "" ? "" : " "}${str(rename(fam))}`);
      continue;
    }
    const v = rest(group);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out.join(",");
}

/** A theme's token values that name fonts (`fontFamily` tokens): each family the theme defines (its `fonts`) as its
 *  prefixed name, so the theme's own fonts load under names no other plugin's can take. */
export function renameFontValue(value: string, pluginId: string, defined: ReadonlySet<string>): string {
  if (defined.size === 0) return value;
  const out = families(tokenize(value), defined, (n) => `${namePrefix(pluginId)}${n}`, false, (toks) => toks.map((t) => t.raw).join(""));
  return (out ?? value).trim();
}
