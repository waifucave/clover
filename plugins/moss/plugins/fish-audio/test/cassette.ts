// The reconstructed responses in `cassettes/fish-api.json`, read as data rather than imported as a JSON module, so the
// fake loads in any package's tests: the core's tests run this plugin through the plugin host with it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CassetteVoice {
  _id: string;
  title: string;
  [field: string]: unknown;
}

export type CassetteError = "401" | "402" | "404" | "415" | "422" | "429" | "503" | "asr_invalid_request" | "asr_invalid_parameter" | "asr_invalid_audio";

export interface Cassette {
  _source: string;
  models: { total: number; items: CassetteVoice[]; has_more: boolean };
  transcript: { text: string; duration: number; segments: unknown[]; language: string; language_code: string };
  errors: Record<CassetteError, Record<string, unknown>>;
}

export const cassette = JSON.parse(readFileSync(join(import.meta.dir, "cassettes", "fish-api.json"), "utf8")) as Cassette;
