// Whether a rendered part leaves its sealed approval frames visible (spec §5.5), for the parts' tests: a DOM
// without layout (happy-dom), the part's own stylesheet, and the elements the sealed kit marks (`data-sealed`).
//
// Chromium's check (IntersectionObserver v2) refuses a frame that has, on itself or anything around it, a filter,
// an opacity below 1, a mask or a clip, or a transform other than a move or an enlargement; and a frame that
// anything is painted over, even a transparent box that ignores the pointer, a shadow or a glow included. Without
// layout this check is conservative. It counts as over a sealed part:
//
//   - an element after it in the tree (painted later) that is out of flow or shifted, or that draws outside its
//     own box (an outer shadow, an outline, a filter);
//   - an element before it, inside the same positioned box, that is out of flow or shifted (positioned boxes
//     paint after the flow around them), and any element lifted by a positive z-index;
//   - a positioned pseudo-element on the part, on anything around it or on anything after it;
//   - inside the part's card, a box that paints as a layer of its own (it isolates, or is positioned with a
//     z-index, or turns, or fades) holding anything that draws outside its box: the layer paints after the card's
//     flow, wherever it sits in the tree, so a glow "beneath" its own row still lands on the field below the row.
//
// unless a negative z-index puts it beneath (in the part's own layer). Hover, focus and active states count as if they were on: a glow
// under the pointer shows exactly when the user is about to click.

import { animatesAny, drawsOver, hidesFrames, hidingKeyframes, lifts, styleRules, type Declaration } from "./css-check";

type Pseudo = "before" | "after";

interface Rule {
  selector: string;
  pseudo: Pseudo | null;
  declarations: readonly Declaration[];
}

const DYNAMIC = /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/gi;
const BEFORE_AFTER = /::?(before|after)\s*$/i;

function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const { selectors, declarations } of styleRules(css)) {
    for (const selector of selectors) {
      const pseudo = BEFORE_AFTER.exec(selector);
      // ::placeholder, ::selection and scrollbars draw inside their own element.
      if (!pseudo && selector.includes("::")) continue;
      const base = (pseudo ? selector.slice(0, pseudo.index) : selector).replace(DYNAMIC, "").trim();
      rules.push({ selector: base || "*", pseudo: pseudo ? (pseudo[1]!.toLowerCase() as Pseudo) : null, declarations });
    }
  }
  return rules;
}

const clean = (value: string) => value.toLowerCase().replace(/!important/, "").trim();

/** What `el` (or its pseudo-element) is given: every matching rule, in sheet order, then its inline style. */
function declarationsOf(el: Element, pseudo: Pseudo | null, rules: readonly Rule[], unknown: Set<string>): Declaration[] {
  const out: Declaration[] = [];
  for (const rule of rules) {
    if (rule.pseudo !== pseudo) continue;
    let hit = false;
    try {
      hit = el.matches(rule.selector);
    } catch {
      unknown.add(rule.selector);
    }
    if (hit) out.push(...rule.declarations);
  }
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!pseudo && style) {
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i);
      out.push({ property, value: style.getPropertyValue(property) });
    }
  }
  return out;
}

function renders(declarations: readonly Declaration[]): boolean {
  return declarations.some((d) => d.property === "content" && !/^(none|normal)$/.test(clean(d.value)));
}

/** Whether a box draws outside itself: an outer shadow, an outline, a filter's spread. */
function overflows(declarations: readonly Declaration[]): string | null {
  for (const { property, value } of declarations) {
    const v = clean(value);
    if (property === "box-shadow" && v !== "none" && v.split(/,(?![^(]*\))/).some((shadow) => !/\binset\b/.test(shadow))) return `box-shadow: ${value}`;
    if ((property === "outline" || property === "outline-style") && v !== "none" && !/^0(px)?\b/.test(v)) return `${property}: ${value}`;
    if (property === "filter" && v !== "none") return `filter: ${value}`;
  }
  return null;
}

function describe(el: Element): string {
  const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  const sealed = el.getAttribute("data-sealed");
  return `<${el.tagName.toLowerCase()}${classes.length ? ` class="${classes.join(" ")}"` : ""}${sealed ? ` data-sealed="${sealed}"` : ""}>`;
}

function hidden(el: Element): boolean {
  return el.hasAttribute("hidden") || (el as HTMLElement).style?.display === "none";
}

function nearestPositioned(part: Element, root: Element, of: (el: Element) => Declaration[]): Element {
  for (let node = part.parentElement; node && node !== root; node = node.parentElement) if (positioned(of(node))) return node;
  return root;
}

/**
 * Every way something in `root` could hide or cover one of its sealed parts at rest (empty when nothing could).
 * `css` is the part's own stylesheet; the elements' inline styles are read as they are.
 */
export function sealedProblems(root: Element, css: string): string[] {
  const rules = rulesOf(css);
  const keyframes = hidingKeyframes(css);
  const unknown = new Set<string>();
  const problems = new Set<string>();
  const all = [...root.querySelectorAll("*")];
  const parts = all.filter((el) => el.hasAttribute("data-sealed"));
  const cache = new Map<Element, Map<Pseudo | null, Declaration[]>>();
  const of = (el: Element, pseudo: Pseudo | null = null): Declaration[] => {
    let byPseudo = cache.get(el);
    if (!byPseudo) cache.set(el, (byPseudo = new Map()));
    let declarations = byPseudo.get(pseudo);
    if (!declarations) byPseudo.set(pseudo, (declarations = declarationsOf(el, pseudo, rules, unknown)));
    return declarations;
  };

  const pseudoOver = (el: Element, part: Element) => {
    for (const pseudo of ["before", "after"] as const) {
      const declarations = of(el, pseudo);
      if (renders(declarations) && (drawsOver(declarations) || lifts(declarations))) {
        problems.add(`${describe(el)}::${pseudo} is drawn over ${describe(part)}`);
      }
    }
  };

  for (const part of parts) {
    // On it and around it: nothing that hides it, nothing drawn over it by a pseudo-element.
    for (let el: Element | null = part; el; el = el === root ? null : el.parentElement) {
      for (const declaration of of(el)) {
        if (hidesFrames(declaration)) problems.add(`${describe(el)} { ${declaration.property}: ${declaration.value} } hides ${describe(part)}`);
        if (declaration.property === "animation" || declaration.property === "animation-name") {
          const name = animatesAny(declaration.value, keyframes);
          if (name) problems.add(`${describe(el)} animates ${name}, which hides ${describe(part)}`);
        }
      }
      pseudoOver(el, part);
    }

    // Everything else, by where it paints.
    const container = nearestPositioned(part, root, of);
    for (const el of all) {
      if (el === part || part.contains(el) || el.contains(part) || hidden(el)) continue;
      const declarations = of(el);
      if (lifts(declarations) && positioned(declarations)) problems.add(`${describe(el)} is lifted over ${describe(part)} by its z-index`);
      if ((part.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        if (drawsOver(declarations)) problems.add(`${describe(el)} comes after ${describe(part)}, out of flow: it is drawn over it`);
        const spill = overflows(declarations);
        if (spill) problems.add(`${describe(el)} comes after ${describe(part)} and draws outside its box (${spill})`);
        pseudoOver(el, part);
      } else if (container.contains(el)) {
        // Positioned boxes paint after the flow of the box they sit in, whatever the tree order.
        if (drawsOver(declarations)) problems.add(`${describe(el)} is positioned inside the same box as ${describe(part)}, so it is drawn over it`);
        pseudoOver(el, part);
      }
    }

    // Layers in the part's card: one that holds anything drawing outside its box paints it over the card's flow.
    const card = part.closest("[data-sealed-card]") ?? root;
    for (const el of card.querySelectorAll("*")) {
      if (el === part || part.contains(el) || el.contains(part) || hidden(el) || !layered(of(el))) continue;
      for (const inner of [el, ...el.querySelectorAll("*")]) {
        const spill = overflows(of(inner)) ?? overflows(of(inner, "before")) ?? overflows(of(inner, "after"));
        if (spill) {
          problems.add(`${describe(el)} paints as a layer of its own over the card's flow, and ${describe(inner)} in it draws outside its box (${spill}) onto ${describe(part)}`);
          break;
        }
      }
    }
  }
  for (const selector of unknown) problems.add(`cannot check the selector ${selector}`);
  return [...problems];
}

/** Whether a box paints as a layer of its own (a stacking context), after the flow it sits in. */
function layered(declarations: readonly Declaration[]): boolean {
  const last = (property: string) => {
    for (let i = declarations.length - 1; i >= 0; i--) if (declarations[i]!.property === property) return clean(declarations[i]!.value);
    return undefined;
  };
  if (last("isolation") === "isolate") return true;
  const z = last("z-index");
  if (positioned(declarations) && z !== undefined && z !== "auto") return true;
  const opacity = last("opacity");
  if (opacity !== undefined && !(parseFloat(opacity) >= 1)) return true;
  for (const property of ["transform", "filter", "backdrop-filter", "perspective", "clip-path", "mask", "mask-image"]) {
    const v = last(property);
    if (v !== undefined && v !== "none") return true;
  }
  const blend = last("mix-blend-mode");
  if (blend !== undefined && blend !== "normal") return true;
  const contain = last("contain");
  return contain !== undefined && /paint|layout|strict|content/.test(contain);
}

function positioned(declarations: readonly Declaration[]): boolean {
  return declarations.some((d) => d.property === "position" && clean(d.value) !== "static");
}
