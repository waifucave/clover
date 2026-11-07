// The user layer (spec §6.1): the user's changes to a bot's name, instructions, model, effort, voice, avatar, theme
// and layout. A field it sets wins over the plugin's, and Reset clears it. Bots can't write it (§9.1): its folder is
// in the fenced set (`userLayersDir`), and the core changes it only for the user (`bot.setUserLayer` is `userOnly`).
// A bot changes itself by editing its plugin folder, which sits under the layer. Owner: lane D.
//
// One file per bot, `<home>/user-layers/<bot>.json`, rewritten whole (atomic-file.ts). The layer syncs with the
// account's settings once lane H's sync exists (§8.5 "bots' user layers … sync").
import { UserLayerPatch, type Text } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { readJson, removeFileDurably, writeJsonAtomic } from "../sessions/atomic-file";
import { userLayerFile } from "./paths";

export const USER_LAYER_FIELDS = ["name", "instructions", "model", "effort", "voice", "avatar", "theme", "layout", "lan"] as const;
export type UserLayerField = (typeof USER_LAYER_FIELDS)[number];

export interface UserLayer {
  name?: Text;
  instructions?: string;
  model?: string;
  effort?: string;
  voice?: { provider: string; voice: string; model?: string };
  avatar?: { file: string; format: string; portrait?: string };
  theme?: string;
  layout?: string;
  /** The bot's browser tabs may reach the LAN (lane L's `lanBots`). The person's alone: in the user layer, which only
   *  the user writes, and never in a plugin's `bot` entry. */
  lan?: boolean;
}

/** A model the layer names is a qualified catalog id (`<provider>/<model>`, §5.9); the catalogs live in the model
 *  plugins, so the shape is all the core checks here. */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]*\/\S+$/;
const EFFORT_RE = /^[a-z0-9][a-z0-9-]*$/;

interface StoredLayer {
  userLayer: 1;
  bot: string;
  fields: UserLayer;
}

/** The layer with a patch applied: `null` clears a field, `undefined` leaves it. */
export function applyUserLayerPatch(layer: UserLayer, patch: UserLayerPatch): UserLayer {
  const next: Record<string, unknown> = { ...layer };
  for (const field of USER_LAYER_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = structuredClone(value);
  }
  return next as UserLayer;
}

export function userLayerFields(layer: UserLayer): UserLayerField[] {
  return USER_LAYER_FIELDS.filter((f) => layer[f] !== undefined);
}

/** Checks a patch as the protocol's schema does, plus the shapes of a model id and an effort. */
export function parseUserLayerPatch(value: unknown): UserLayerPatch {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const unknown = Object.keys(value).filter((k) => !(USER_LAYER_FIELDS as readonly string[]).includes(k));
    if (unknown.length > 0) throw new ContractError("invalid", `a user layer has no ${unknown.map((k) => `"${k}"`).join(", ")}; its fields are ${USER_LAYER_FIELDS.join(", ")}`);
  }
  const parsed = UserLayerPatch.safeParse(value);
  if (!parsed.success) throw new ContractError("invalid", `not a user-layer change: ${parsed.error.issues.map((i) => `${i.path.join(".") || "patch"}: ${i.message}`).join("; ")}`);
  const patch = parsed.data;
  if (typeof patch.model === "string" && !MODEL_ID_RE.test(patch.model)) throw new ContractError("invalid", `"${patch.model}" is not a qualified model id (<provider>/<model>)`);
  if (typeof patch.effort === "string" && !EFFORT_RE.test(patch.effort)) throw new ContractError("invalid", `"${patch.effort}" is not an effort`);
  if (typeof patch.instructions === "string" && patch.instructions.trim() === "") throw new ContractError("invalid", "a bot's instructions can't be empty; clear the field to use the plugin's");
  return patch;
}

/** What a stored file holds, keeping only the fields that still parse. */
function fieldsOf(value: unknown): UserLayer {
  const v = value as Partial<StoredLayer> | undefined;
  if (v?.userLayer !== 1 || typeof v.fields !== "object" || v.fields === null) return {};
  const out: Record<string, unknown> = {};
  for (const field of USER_LAYER_FIELDS) {
    const one = UserLayerPatch.safeParse({ [field]: (v.fields as Record<string, unknown>)[field] });
    const parsed = one.success ? (one.data as Record<string, unknown>)[field] : undefined;
    if (parsed !== undefined && parsed !== null) out[field] = parsed;
  }
  return out as UserLayer;
}

export class UserLayerStore {
  readonly #home: string;
  readonly #cache = new Map<string, UserLayer>();

  constructor(home: string) {
    this.#home = home;
  }

  get(botId: string): UserLayer {
    let layer = this.#cache.get(botId);
    if (layer === undefined) {
      layer = fieldsOf(readJson(userLayerFile(this.#home, botId)));
      this.#cache.set(botId, layer);
    }
    return structuredClone(layer);
  }

  /** Applies a checked patch and stores the result; an empty layer leaves no file. */
  set(botId: string, patch: UserLayerPatch): UserLayer {
    const next = applyUserLayerPatch(this.get(botId), patch);
    const path = userLayerFile(this.#home, botId);
    if (userLayerFields(next).length === 0) removeFileDurably(path);
    else writeJsonAtomic(path, { userLayer: 1, bot: botId, fields: next } satisfies StoredLayer);
    this.#cache.set(botId, next);
    return structuredClone(next);
  }

  /** Reset: every field back to the plugin's. */
  reset(botId: string): void {
    removeFileDurably(userLayerFile(this.#home, botId));
    this.#cache.set(botId, {});
  }
}
