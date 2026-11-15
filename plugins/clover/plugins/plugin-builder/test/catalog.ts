// The catalog reference in skills/plugin-catalog/SKILL.md, made from the SDK's own catalogs, so it can't drift: the
// test regenerates it and compares; `bun run gen` writes it.
import {
  API_CALLS, CAPABILITIES, CORE_POINTS, DATA_POINTS, HOOK_EVENTS, HOOK_RETURNS, SPOTS, TOKENS, cssProperty, type ApiCallInfo,
} from "@waifucave/clover-plugin-sdk";

export const BEGIN = "<!-- generated: the catalogs (bun run gen in plugins/clover/plugins/plugin-builder) -->";
export const END = "<!-- end generated -->";

const one = (s: string, max = 220) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

export function catalogReference(): string {
  const out: string[] = [BEGIN, ""];
  out.push("## The core's points (a top-level `contributes` key each)", "");
  out.push("| key | shape | data or code | what the core does with it |", "| :- | :- | :- | :- |");
  for (const p of CORE_POINTS) {
    if (p.side === "app" && p.name !== "themes" && p.name !== "locales") continue; // spots: under `ui` (below)
    out.push(`| \`${p.name}\` | ${p.shape} | ${p.kind} | ${one(p.doc, 160)} |`);
  }
  out.push("", "## Spots (fill one with a `contributes.ui` entry: `{ \"spot\": \"<name>\", … }`)", "");
  out.push("| spot | shape | declared by | needs | what it is |", "| :- | :- | :- | :- | :- |");
  for (const s of SPOTS as readonly { name: string; shape: string; declaredBy: string; needs?: readonly string[]; doc: string }[]) {
    out.push(`| \`${s.name}\` | ${s.shape} | ${s.declaredBy} | ${(s.needs ?? []).map((n) => `\`${n}\``).join(", ") || "—"} | ${one(s.doc)} |`);
  }
  out.push("", "## Data points other plugins declared (a top-level `contributes` key each)", "");
  for (const p of DATA_POINTS) out.push(`- \`${p.name}\` (${p.shape}, ${p.kind}, declared by ${p.declaredBy}): ${one(p.doc)}`);
  out.push("", "## Capabilities (`capabilities` in the manifest; each is a line on the OK card)", "");
  out.push("| capability | what it lets | the OK card says | |", "| :- | :- | :- | :- |");
  for (const c of CAPABILITIES) out.push(`| \`${c.name}\` | ${one(c.lets, 180)} | ${c.ok} | ${c.bundledOnly ? "Clover's own plugins only" : c.warns ? "a warning" : ""} |`);
  out.push("", "## The plugin API's calls (`api.<path>`), by capability", "");
  out.push("`where`: `host` a host half, `ui` a component, `both` either, `own` a host half in a process of its own (`host.process: \"own\"`), `clover` Clover's own process only.", "");
  const calls = Object.entries(API_CALLS as Record<string, ApiCallInfo>);
  const byCap = new Map<string, [string, ApiCallInfo][]>();
  for (const e of calls) {
    const k = e[1].capability ?? "(none: every plugin)";
    byCap.set(k, [...(byCap.get(k) ?? []), e]);
  }
  // Within a capability, by name: the SDK's own order is how its lines happened to merge, which the reference
  // shouldn't follow.
  for (const [cap, list] of byCap) {
    list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    out.push(`- **${cap}**: ${list.map(([path, i]) => `\`${path}\` (${i.where}${i.notYet ? `; NOT SERVED YET: ${i.notYet}` : ""})`).join(", ")}`);
  }
  out.push("", "## Hook events (`contributes.hooks[].on`) and what a hook may return on each", "");
  for (const e of HOOK_EVENTS) out.push(`- \`${e}\`: ${HOOK_RETURNS[e].length ? HOOK_RETURNS[e].map((r) => `\`${r}\``).join(", ") : "nothing (it only observes)"}`);
  out.push("", "## Design tokens (a theme's `tokens`; a component reads them as CSS variables)", "");
  const groups = new Map<string, string[]>();
  for (const t of TOKENS) {
    const g = t.name.split(".")[0]!;
    groups.set(g, [...(groups.get(g) ?? []), `\`${t.name}\` (${t.type})`]);
  }
  out.push(`Each token is the CSS variable \`${cssProperty("color.accent")}\` for \`color.accent\`: its dots become dashes, after \`--clover-\`.`, "");
  for (const [g, names] of groups) out.push(`- **${g}**: ${names.join(", ")}`);
  out.push("", END);
  return out.join("\n");
}

/** The skill's text with its generated block replaced by `catalogReference()`. */
export function withReference(skill: string): string {
  const a = skill.indexOf(BEGIN), b = skill.indexOf(END);
  if (a < 0 || b < a) throw new Error("the skill has no generated block");
  return skill.slice(0, a) + catalogReference() + skill.slice(b + END.length);
}
