// The avatar's words, in locale format 1's shape (spec §5.9): keys start with `clover.`, strings use `{name}`
// placeholders. Until the app's `t()` exists (lane E), this is the English table and a stand-in lookup with the
// same rules. A refusal's words come from its reason, never from the check's technical detail.

export const EN: Readonly<Record<string, string>> = {
  "clover.vrm.gettingReady": "Getting {name} ready…",
  "clover.vrm.cantShow": "{name}'s avatar can't be shown",
  "clover.vrm.noWebgl": "This computer can't draw the 3D avatar here.",
  "clover.vrm.by": "by {author}",
  "clover.vrm.refused.too-large": "The avatar file is too large to load here.",
  "clover.vrm.refused.not-glb": "The avatar file is not a VRM model.",
  "clover.vrm.refused.malformed": "The avatar file is damaged.",
  "clover.vrm.refused.not-vrm": "The file holds a 3D model, but not a VRM avatar.",
  "clover.vrm.refused.unsupported-extension": "The model uses something this app can't draw.",
  "clover.vrm.refused.external-reference": "The model points to files outside itself.",
  "clover.vrm.refused.over-budget": "The model is too heavy to draw here.",
  "clover.vrm.refused.unaccepted-licence": "A VRM 1.0 model must carry the VRM Public License 1.0, and this one doesn't.",
  "clover.vrm.refused.unreadable": "The avatar file could not be read.",
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const text = EN[key];
  if (text === undefined) return key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
