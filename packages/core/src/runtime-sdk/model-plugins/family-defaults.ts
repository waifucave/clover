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
