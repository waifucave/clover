// A small CSS reader for the stylesheet tests: rules with their selectors, the at-rules around them,
// and their declarations. Enough for the flat stylesheets these parts ship (no nesting).
export interface CssRule {
  prelude: string;
  context: string[];
  declarations: { property: string; value: string }[];
}

export function parseCss(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const stack: { prelude: string; bodyStart: number }[] = [];
  let segmentStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      stack.push({ prelude: text.slice(segmentStart, i).trim(), bodyStart: i + 1 });
      segmentStart = i + 1;
    } else if (c === "}") {
      const top = stack.pop();
      if (!top) throw new Error(`unbalanced } at ${i}`);
      const body = text.slice(top.bodyStart, i);
      if (!body.includes("{")) {
        rules.push({
          prelude: top.prelude,
          context: stack.map((s) => s.prelude),
          declarations: body
            .split(";")
            .map((d) => d.trim())
            .filter((d) => d.length > 0)
            .map((d) => {
              const colon = d.indexOf(":");
              return { property: d.slice(0, colon).trim().toLowerCase(), value: d.slice(colon + 1).trim() };
            }),
        });
      }
      segmentStart = i + 1;
    } else if (c === ";" && stack.length === 0) {
      segmentStart = i + 1;
    }
  }
  if (stack.length > 0) throw new Error("unbalanced {");
  return rules;
}

/** The selector's subject: its last compound selector. */
export function subjectOf(selector: string): string {
  const parts = selector.trim().split(/\s+|>|\+|~/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "";
}

/** Colour literals a component stylesheet must not hold: colours come from tokens. */
export const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink)\b/;

/** Properties that fade, filter or transform: around a sealed frame they stop clicks counting. */
export const FRAME_UNSAFE = new Set(["opacity", "filter", "backdrop-filter", "transform", "rotate", "scale", "zoom", "mix-blend-mode"]);

/** True when a value of an unsafe property is harmless anywhere: full opacity, a move, no filter. */
export function harmless(property: string, value: string): boolean {
  const v = value.replace(/\s*!important$/, "").trim();
  if (property === "opacity") return Number(v) >= 1;
  if (property === "filter" || property === "backdrop-filter" || property === "mix-blend-mode") return v === "none" || v === "normal";
  if (property === "transform") return v === "none" || /^(translate[XYZ3d]*\([^)]*\)\s*)+$/.test(v);
  return v === "none";
}

/** Checks a stylesheet against the sealed-frame rule: anything unsafe sits only on a leaf in
 *  `leaves`, directly or through a keyframes animation. Returns the offending rules. */
export function frameUnsafeRules(css: string, leaves: readonly string[]): string[] {
  const rules = parseCss(css);
  const unsafeKeyframes = new Set<string>();
  for (const rule of rules) {
    const keyframes = rule.context.find((c) => c.startsWith("@keyframes"));
    if (!keyframes) continue;
    if (rule.declarations.some((d) => FRAME_UNSAFE.has(d.property) && !harmless(d.property, d.value))) {
      unsafeKeyframes.add(keyframes.replace("@keyframes", "").trim());
    }
  }
  const isLeaf = (selector: string) => {
    const subject = subjectOf(selector);
    return leaves.some((leaf) => subject === leaf || subject.startsWith(`${leaf}:`) || subject.startsWith(`${leaf}[`) || subject.endsWith(leaf));
  };
  const offending: string[] = [];
  for (const rule of rules) {
    if (rule.context.some((c) => c.startsWith("@keyframes"))) continue;
    const unsafe = rule.declarations.some((d) => {
      if (FRAME_UNSAFE.has(d.property) && !harmless(d.property, d.value)) return true;
      if (d.property === "animation" || d.property === "animation-name") return [...unsafeKeyframes].some((k) => d.value.split(/[\s,]+/).includes(k));
      return false;
    });
    if (unsafe && !rule.prelude.split(",").every(isLeaf)) offending.push(rule.prelude);
  }
  return offending;
}
