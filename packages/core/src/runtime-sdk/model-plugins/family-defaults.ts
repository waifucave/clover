// Each model family's ONE default: a model (by the catalog's canonical id) and an effort (the owner, 2026-11-20: "default
// pick a default per model family, claude would be opus 5.5 at medium. gpt would be gpt 6.2 sol at medium."). A provider's
// recommended model is its family's default as that provider serves it (`default-model.ts`); the effort is written with it.
//
// Kept here, beside the code that reads the catalog, because the families are declared in the agent SDK's catalog package
// (`@waifucave/clover-provider-catalog`), which this repo installs and cannot change without a release of it. One line
// per family; Claude and GPT are the owner's, the rest are the lane's picks (each family's balanced tier at medium where
// its rows take an effort), his to change. A family not listed (`o-series`, `other`) recommends nothing.
export interface FamilyDefault {
  /** The catalog's canonical model id (`row.canonicalModelId`). */
  model: string;
  /** The effort written with it; dropped for a row whose effort list doesn't hold it. */
  effort?: string;
}

export const FAMILY_DEFAULTS: Readonly<Record<string, FamilyDefault>> = {
  claude: { model: "claude-opus-5.5", effort: "medium" }, // the owner's
  gpt: { model: "gpt-6.2-sol", effort: "medium" }, // the owner's
  gemini: { model: "gemini-3.7-flash", effort: "medium" },
  grok: { model: "grok-4.6", effort: "medium" },
  deepseek: { model: "deepseek-v4-pro", effort: "medium" },
  kimi: { model: "kimi-k3.1-pro", effort: "medium" },
  qwen: { model: "qwen3.7-plus", effort: "medium" },
  mistral: { model: "mistral-medium-3.5", effort: "medium" },
  glm: { model: "glm-5.3", effort: "medium" },
  minimax: { model: "minimax-m3", effort: "medium" },
  command: { model: "command-a-03-2025", effort: "medium" },
  mimo: { model: "mimo-v2.6-pro", effort: "medium" },
  llama: { model: "llama-4-scout-17b-16e-instruct", effort: "medium" },
  nova: { model: "amazon.nova-pro", effort: "medium" },
  nemotron: { model: "nemotron-3-super-120b-a12b", effort: "medium" },
  ernie: { model: "ernie-5.1", effort: "medium" },
  hunyuan: { model: "hy4-preview", effort: "medium" },
  muse: { model: "muse-spark-1.3", effort: "medium" },
  gemma: { model: "gemma-4-31b-it", effort: "medium" },
  "gpt-oss": { model: "gpt-oss-120b", effort: "medium" },
};

// Each model family's LIGHT model, beside its default and in the same shape (the owner, 2026-11-21: "a light model per
// family"): the cheap, fast tier MOSS's own background jobs (conversation titles, memory tidying) run on, so a title is
// not written by the person's strongest model. The same rule for every family, so a provider plugin's family gets one by
// declaring it here, and no code names a plugin. The lane's picks, his to change:
//   * a family whose catalog names a smaller tier takes it (Claude: Haiku 5.5, which the catalog carries beside its
//     slot list; GPT: the `luna` slot; Gemini `lite`; DeepSeek `flash`; GLM and MiMo `flash`; Mistral `small`; Qwen `small`;
//     Nova `micro`; gpt-oss `20b`);
//   * a family with no cheaper tier (one model, or tiers that differ in speed or purpose, not size) has its default as
//     its light model; the effort is what makes the job light there.
// The effort is the one a job that has none of its own asks for (titles; the dreamer and the cleaner keep theirs) when the
// person set none for it; a row that doesn't list it drops it.
// A family not listed (`o-series`, `other`) has no light model.
export const FAMILY_LIGHT_MODELS: Readonly<Record<string, FamilyDefault>> = {
  claude: { model: "claude-haiku-5.5", effort: "low" },
  gpt: { model: "gpt-6-luna", effort: "low" },
  gemini: { model: "gemini-3.1-flash-lite", effort: "low" },
  deepseek: { model: "deepseek-flash", effort: "low" },
  glm: { model: "glm-4.7-flash", effort: "low" },
  mimo: { model: "mimo-v2.6-flash", effort: "low" },
  mistral: { model: "mistral-small-latest", effort: "low" },
  qwen: { model: "qwen3.6-27b", effort: "low" },
  nova: { model: "amazon.nova-micro", effort: "low" },
  "gpt-oss": { model: "gpt-oss-20b", effort: "low" },
  // One tier, or tiers that differ in speed or purpose rather than size: the default is the light model.
  grok: { model: "grok-4.6", effort: "low" },
  kimi: { model: "kimi-k3.1-pro", effort: "low" },
  minimax: { model: "minimax-m3", effort: "low" },
  command: { model: "command-a-03-2025", effort: "low" },
  llama: { model: "llama-4-scout-17b-16e-instruct", effort: "low" },
  nemotron: { model: "nemotron-3-super-120b-a12b", effort: "low" },
  ernie: { model: "ernie-5.1", effort: "low" },
  hunyuan: { model: "hy4-preview", effort: "low" },
  muse: { model: "muse-spark-1.3", effort: "low" },
  gemma: { model: "gemma-4-31b-it", effort: "low" },
};
