// A plugin's settings (spec §5.4 "Settings", §5.9 `settings`): `settings.get`, `settings.watch` and `settings.set` in
// the plugin API, and `plugin.settings.get` / `plugin.settings.set` for the user's clients.
//
// * A plugin reads and changes only its own values, from its host half or its components alike. The keys are the
//   manifest's `settings`; any other key is `not_found`. A value not set reads as the manifest's `default`.
// * `scope`: `account` (synced with the account; lane H syncs the file), `device` (this computer only) and `bot` (one
//   value per bot, so a call names `bot`).
// * Values are checked against the field: `string` (up to 8,192 characters), `number` (finite, within `min`/`max`),
//   `boolean`, `enum` (one of `options`), `color` (`#rrggbb` or `#rrggbbaa`). `null` goes back to the default.
// * A `secret` field never passes through here as a value: the plugin API refuses it (a plugin gets a secret only
//   through the keyed fetch, or `secrets.get` in a process of its own), and the user's `plugin.settings.set` puts it in
//   the credential store (`SecretStore`, owner the plugin, named by the key), so `plugin.settings.get` says only
//   whether one is stored.
// * The values sit in the fenced settings folder (`<home>/settings/plugins/<id>.json`), which no bot writes (§9.1).
import { BotId, PLUGINS_METHODS, type PluginSettingView } from "@waifucave/clover-protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContractError, Listeners, type Unsubscribe } from "../../contracts/common";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import type { SecretStore } from "../../contracts/secret-store";
import type { Setting } from "@waifucave/clover-plugin-sdk";
import { handler, requireUser, type MethodHandler } from "../../rpc/handler";
import { pluginPath } from "./storage";
import { readJsonOrKeepAside } from "../paths";
import { randomUUID } from "node:crypto";
import { listenerArg, stringArg, type ApiHandlers } from "./router";

/** What one plugin's file holds. */
export interface PluginSettingValues {
  account: Record<string, unknown>;
  device: Record<string, unknown>;
  bot: Record<string, Record<string, unknown>>;
}

export interface PluginSettingsBackend {
  read(pluginId: string): PluginSettingValues;
  write(pluginId: string, values: PluginSettingValues): void;
}

const empty = (): PluginSettingValues => ({ account: {}, device: {}, bot: {} });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function filePluginSettings(cloverHome: string): PluginSettingsBackend {
  const file = (id: string) => `${pluginPath(join(cloverHome, "settings", "plugins"), id)}.json`;
  return {
    read(id) {
      const f = file(id);
      if (!existsSync(f)) return empty();
      const v = readJsonOrKeepAside(f, `${id}'s settings`);
      return { account: isObject(v.account) ? v.account : {}, device: isObject(v.device) ? v.device : {}, bot: isObject(v.bot) ? (v.bot as PluginSettingValues["bot"]) : {} };
    },
    write(id, values) {
      const f = file(id);
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(values), { mode: 0o600 });
      renameSync(tmp, f);
    },
  };
}

export function memoryPluginSettings(): PluginSettingsBackend {
  const data = new Map<string, PluginSettingValues>();
  return { read: (id) => structuredClone(data.get(id) ?? empty()), write: (id, v) => void data.set(id, structuredClone(v)) };
}

/** Checks a value for a field; returns it as stored. `secret` fields never take one here. */
export function checkSettingValue(key: string, field: Setting, value: unknown): unknown {
  const bad = (why: string) => new ContractError("invalid", `${key}: ${why}`);
  switch (field.type) {
    case "string":
      if (typeof value !== "string" || value.length > 8192) throw bad("a string of up to 8,192 characters");
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad("a number");
      if (field.min !== undefined && value < field.min) throw bad(`at least ${field.min}`);
      if (field.max !== undefined && value > field.max) throw bad(`at most ${field.max}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw bad("true or false");
      return value;
    case "enum": {
      const options = (field.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
      if (typeof value !== "string" || !options.includes(value)) throw bad(`one of ${options.join(", ")}`);
      return value;
    }
    case "color":
      if (typeof value !== "string" || !/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) throw bad("a color, #rrggbb or #rrggbbaa");
      return value;
    case "secret":
      throw new ContractError("refused", `${key} is a secret: the user sets it, and the plugin gets it only through the keyed fetch or secrets.get`);
    default:
      throw bad(`a setting of a type this Clover doesn't know (${String((field as { type?: unknown }).type)})`);
  }
}

export interface PluginSettingsOptions {
  registry: Pick<PluginRegistry, "get"> & Partial<Pick<PluginRegistry, "watch">>;
  backend: PluginSettingsBackend;
  /** For `secret` fields: the credential store (C's). Absent: a secret can't be set here. */
  secrets?: Pick<SecretStore, "set" | "delete" | "list">;
}

/** One change: the plugin and its key (and bot, for a `bot` value). */
export interface SettingChange {
  pluginId: string;
  key: string;
  bot?: string;
}

export class PluginSettings {
  readonly #o: PluginSettingsOptions;
  readonly #changes = new Listeners<SettingChange>();

  constructor(o: PluginSettingsOptions) {
    this.#o = o;
    // A plugin changed (an update may have made a plain field a secret): its plaintext goes at once.
    o.registry.watch?.((c) => {
      if (c.type === "entries" || c.type === "removed") return;
      try {
        if (o.registry.get(c.id) !== undefined) void this.scrubSecrets(c.id).catch(() => {});
      } catch {
        /* not a plugin with settings */
      }
    });
  }

  /** The manifest's field, or `not_found`. */
  field(pluginId: string, key: string): Setting {
    const record = this.#o.registry.get(pluginId);
    if (record === undefined) throw new ContractError("not_installed", `${pluginId} isn't installed`);
    const settings = record.manifest?.settings;
    const f = settings !== undefined && Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (f === undefined) throw new ContractError("not_found", `${pluginId} has no setting ${key}`);
    return f;
  }

  fields(pluginId: string): [string, Setting][] {
    const record = this.#o.registry.get(pluginId);
    if (record === undefined) throw new ContractError("not_installed", `${pluginId} isn't installed`);
    return Object.entries(record.manifest?.settings ?? {});
  }

  #slot(values: PluginSettingValues, field: Setting, key: string, bot: string | undefined, make: boolean): Record<string, unknown> | undefined {
    const scope = field.scope ?? "account";
    if (scope === "bot") {
      if (bot === undefined || !BotId.safeParse(bot).success) throw new ContractError("invalid", `${key} has one value per bot: name the bot`);
      if (values.bot[bot] === undefined && make) values.bot[bot] = {};
      return values.bot[bot];
    }
    return scope === "device" ? values.device : values.account;
  }

  /** The value in effect, or undefined; `secret` fields are refused (see the header). */
  get(pluginId: string, key: string, bot?: string): unknown {
    const field = this.field(pluginId, key);
    if (field.type === "secret") checkSettingValue(key, field, undefined);
    const slot = this.#slot(this.#o.backend.read(pluginId), field, key, bot, false);
    return slot !== undefined && Object.hasOwn(slot, key) ? slot[key] : field.default;
  }

  /** Sets (or with `null`/undefined resets) a value; `secret` fields are refused (the user's go through `setByUser`). */
  set(pluginId: string, key: string, value: unknown, bot?: string): void {
    const field = this.field(pluginId, key);
    const stored = value === null || value === undefined ? undefined : checkSettingValue(key, field, value);
    if (field.type === "secret") checkSettingValue(key, field, value);
    const values = this.#o.backend.read(pluginId);
    const slot = this.#slot(values, field, key, bot, true)!;
    if (stored === undefined) delete slot[key];
    else slot[key] = stored;
    this.#o.backend.write(pluginId, values);
    this.#changes.emit({ pluginId, key, ...(field.scope === "bot" && bot !== undefined ? { bot } : {}) });
  }

  /** The user's change (`plugin.settings.set`): a `secret` goes into the credential store and never comes back. */
  async setByUser(pluginId: string, key: string, value: unknown, bot?: string): Promise<void> {
    const field = this.field(pluginId, key);
    if (field.type !== "secret") return this.set(pluginId, key, value, bot);
    if (this.#o.secrets === undefined) throw new ContractError("locked", "the credential store isn't open on this computer");
    const ref = { owner: { kind: "plugin" as const, pluginId }, name: key };
    if (value === null || value === undefined) await this.#o.secrets.delete(ref);
    else if (typeof value !== "string" || value.length === 0 || value.length > 16_384) throw new ContractError("invalid", `${key}: a secret is a string of 1 to 16,384 characters`);
    else await this.#o.secrets.set(ref, value);
    this.#changes.emit({ pluginId, key });
  }

  /** A field that is a `secret` now but held a plain value before (an update changed its type, #332's review): the
   *  value moves into the credential store (when there is one, and no secret is stored yet) and is scrubbed from the
   *  settings file either way. Returns the keys moved or scrubbed. */
  async scrubSecrets(pluginId: string): Promise<string[]> {
    const secretKeys = this.fields(pluginId).filter(([, f]) => f.type === "secret").map(([k]) => k);
    if (secretKeys.length === 0) return [];
    const values = this.#o.backend.read(pluginId);
    const slots = [values.account, values.device, ...Object.values(values.bot)];
    const scrubbed: string[] = [];
    for (const key of secretKeys) {
      const found = slots.find((s) => Object.hasOwn(s, key));
      if (found === undefined) continue;
      const plain = found[key];
      if (this.#o.secrets !== undefined && typeof plain === "string" && plain !== "" && plain.length <= 16_384) {
        const ref = { owner: { kind: "plugin" as const, pluginId }, name: key };
        const stored = (await this.#o.secrets.list({ kind: "plugin", pluginId })).some((m) => m.ref.name === key);
        if (!stored) await this.#o.secrets.set(ref, plain);
      }
      for (const s of slots) delete s[key];
      scrubbed.push(key);
    }
    if (scrubbed.length > 0) this.#o.backend.write(pluginId, values);
    return scrubbed;
  }

  /** The fields as Settings shows them; a secret's value never, only whether one is stored. */
  async views(pluginId: string, bot?: string): Promise<PluginSettingView[]> {
    await this.scrubSecrets(pluginId);
    const values = this.#o.backend.read(pluginId);
    const stored = new Set((this.#o.secrets ? await this.#o.secrets.list({ kind: "plugin", pluginId }) : []).map((m) => m.ref.name));
    return this.fields(pluginId).map(([key, f]) => {
      const scope = f.scope ?? "account";
      const base = { key, type: f.type, title: typeof f.title === "string" ? f.title : key, ...(typeof f.description === "string" ? { description: f.description } : {}), scope, required: f.required === true };
      if (f.type === "secret") return { ...base, set: stored.has(key) };
      const slot = scope === "bot" ? (bot === undefined ? undefined : values.bot[bot]) : scope === "device" ? values.device : values.account;
      const set = slot !== undefined && Object.hasOwn(slot, key);
      const value = set ? slot[key] : f.default;
      return { ...base, ...(value === undefined ? {} : { value }), set };
    });
  }

  watch(fn: (change: SettingChange) => void): Unsubscribe {
    return this.#changes.add(fn);
  }
}

const botOpt = (v: unknown): string | undefined => (typeof v === "object" && v !== null && typeof (v as { bot?: unknown }).bot === "string" ? (v as { bot: string }).bot : undefined);

export function settingsApi(settings: PluginSettings): ApiHandlers {
  return {
    "settings.get": (ctx, args) => settings.get(ctx.pluginId, stringArg(args, 0, "a setting key", 128), botOpt(args[1])),
    "settings.set": (ctx, args) => void settings.set(ctx.pluginId, stringArg(args, 0, "a setting key", 128), args[1], botOpt(args[2])),
    "settings.watch": (ctx, args): Unsubscribe => {
      const key = args[0] === null ? null : stringArg(args, 0, "a setting key", 128);
      if (key !== null) settings.field(ctx.pluginId, key);
      const listener = listenerArg<string>(args, 1);
      return settings.watch((c) => {
        if (c.pluginId === ctx.pluginId && (key === null || c.key === key)) listener(c.key);
      });
    },
  };
}

/** `plugin.settings.get` and `plugin.settings.set` on the user's connections. */
export function pluginSettingsMethods(settings: PluginSettings): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  return {
    [M.pluginSettingsGet.name]: handler(M.pluginSettingsGet, async (p) => ({ settings: await settings.views(p.id, p.bot) })),
    [M.pluginSettingsSet.name]: handler(M.pluginSettingsSet, async (p, ctx) => {
      requireUser(ctx, "change a plugin's settings");
      await settings.setByUser(p.id, p.key, p.value, p.bot);
      return { applied: true as const };
    }),
  };
}
