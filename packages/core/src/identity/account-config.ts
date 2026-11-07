// Where the daemon's waifucave account and handshake are (lane I's services): the sign-in project, the account
// service and the handshake, as plain public settings. Nothing here is a secret:
//   - The Supabase anon key is public by design (it goes into every web page that signs in).
//   - Which account this device is signed in to is its session, kept in the secret store (`ACCOUNT_SESSION_REF`), as
//     are the device key and the box key.
//
// The settings come from, in order:
//   1. The environment (`CLOVER_ACCOUNT_*`, `CLOVER_HANDSHAKE_URL`), in dev and test builds only. A release build
//      ignores them and says so once (`build-kind.ts`): anything that can start `clover-core` could otherwise point the
//      device's sign-in and its device key's statements at a server of its choosing.
//   2. `<clover home>/account.json`, read strictly: an unknown key (a token or secret put there by mistake included)
//      refuses the whole file, which is then not used. A release build takes from it only the settings production
//      leaves unset (today the sign-in project's, `authUrl` and `anonKey`, both public), never the account service or
//      the handshake, and says once that it did; once production has them all, a release build ignores the file.
//   3. The built-in production values.
//
// With no sign-in project (`authUrl` and `anonKey`) the account is off: the daemon runs signed out and a sign-in says
// it isn't set up in this build. URLs are https; plain http only for a loopback address, and only where the
// environment may override (dev and test builds).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST_BUILD, noteIgnoredEnvOverride } from "../build-kind";
import type { SecretStore } from "../contracts/secret-store";
import { WAIFUCAVE_DEVICE_SERVICES } from "../devices/account-devices";
import { HandshakeRendezvous } from "../links/handshake-rendezvous";
import type { PairingRendezvous } from "../links/pairing";
import { AccountClient, type AccountConfig } from "./account";
import { DeviceKey } from "./device-key";

/** The file in the Clover home. */
export const ACCOUNT_CONFIG_FILE = "account.json";

/** The account service's production origin (services/accounts/PROTOCOL.md, "Where it lives"). */
export const PRODUCTION_ACCOUNT_SERVICE = "https://waifucave.com/auth";

/** The settings, and the environment variable that overrides each in dev and test builds. */
export const ACCOUNT_SETTINGS = {
  authUrl: "CLOVER_ACCOUNT_AUTH_URL",
  anonKey: "CLOVER_ACCOUNT_ANON_KEY",
  serviceUrl: "CLOVER_ACCOUNT_SERVICE_URL",
  emailSignInUrl: "CLOVER_ACCOUNT_EMAIL_SIGN_IN_URL",
  handshakeUrl: "CLOVER_HANDSHAKE_URL",
} as const;

export type AccountSetting = keyof typeof ACCOUNT_SETTINGS;

const URL_SETTINGS: readonly AccountSetting[] = ["authUrl", "serviceUrl", "emailSignInUrl", "handshakeUrl"];

/** The built-in values. The sign-in project's are the owner's to set (live gate); until then a build has none. */
export const PRODUCTION_ACCOUNT_SETTINGS: Readonly<Partial<Record<AccountSetting, string>>> = Object.freeze({
  serviceUrl: PRODUCTION_ACCOUNT_SERVICE,
  handshakeUrl: WAIFUCAVE_DEVICE_SERVICES.handshake.url,
});

/** A refused key is named in a log only when it looks like a setting's name; anything else could be a pasted secret. */
const NAMEABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export interface ResolvedAccountConfig {
  /** The account client's settings; null when the account is off. */
  account: AccountConfig | null;
  /** Why the account is off, when it is. */
  off?: string;
  /** The handshake's origin (pairs, the account channel, the lease, and short codes' rendezvous). */
  handshakeUrl: string;
  /** Where each setting came from. */
  sources: Partial<Record<AccountSetting, "env" | "file" | "default">>;
  /** What was set but not used, and why. Never a value: a misplaced secret must not reach a log. */
  problems: string[];
}

export interface ResolveAccountConfigOptions {
  /** The Clover home, where `account.json` lives. */
  home: string;
  env?: Record<string, string | undefined>;
  /** Tests only. The daemon never passes this, and nothing derives it from the environment: it defaults to the
   *  compile-time `DIST_BUILD` (build-kind.ts), which is what makes a release build ignore the environment. */
  distBuild?: boolean;
  /** Tests only: production's built-in settings (`PRODUCTION_ACCOUNT_SETTINGS`), to test a build that has them all. */
  production?: Readonly<Partial<Record<AccountSetting, string>>>;
  log?(line: string): void;
}

export function resolveAccountConfig(o: ResolveAccountConfigOptions): ResolvedAccountConfig {
  const dist = o.distBuild ?? DIST_BUILD;
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.error(l));
  const production = o.production ?? PRODUCTION_ACCOUNT_SETTINGS;
  const problems: string[] = [];
  // No prototype: nothing a file names can reach an inherited property.
  const values = Object.create(null) as Partial<Record<AccountSetting, string>>;
  const sources = Object.create(null) as ResolvedAccountConfig["sources"];

  for (const k of Object.keys(ACCOUNT_SETTINGS) as AccountSetting[]) {
    const v = Object.hasOwn(production, k) ? production[k] : undefined;
    if (v === undefined) continue;
    values[k] = v;
    sources[k] = "default";
  }
  let fromFile = 0;
  for (const [k, v] of readAccountFile(o.home, problems)) {
    // A release build takes from the file only what production leaves unset, so it tightens by itself once
    // production has every setting.
    if (dist && values[k] !== undefined) {
      problems.push(`${ACCOUNT_CONFIG_FILE}'s ${k} isn't used: a release build keeps production's`);
      continue;
    }
    values[k] = v;
    sources[k] = "file";
    fromFile++;
  }
  if (dist && fromFile > 0) log(`[account] the account settings came from ${ACCOUNT_CONFIG_FILE}`);
  for (const [k, name] of Object.entries(ACCOUNT_SETTINGS) as [AccountSetting, string][]) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    if (dist) {
      noteIgnoredEnvOverride(name, log);
      continue;
    }
    values[k] = v;
    sources[k] = "env";
  }

  // Each URL checked; a bad one is dropped (the handshake falls back to production's, an account setting turns the
  // account off).
  for (const k of URL_SETTINGS) {
    const v = values[k];
    if (v === undefined) continue;
    const why = badUrl(v, !dist);
    if (why) {
      problems.push(`${k} (from ${sources[k]}) isn't used: ${why}`);
      delete values[k];
      delete sources[k];
    }
  }
  const anonKey = values.anonKey;
  if (anonKey !== undefined && (anonKey.length > 4096 || /[\s\p{Cc}]/u.test(anonKey))) {
    problems.push(`anonKey (from ${sources.anonKey}) isn't used: not a key`);
    delete values.anonKey;
    delete sources.anonKey;
  }

  const handshakeUrl = values.handshakeUrl ?? WAIFUCAVE_DEVICE_SERVICES.handshake.url;
  const missing = (["authUrl", "anonKey", "serviceUrl"] as const).filter((k) => values[k] === undefined);
  const resolved: ResolvedAccountConfig = { account: null, handshakeUrl: trimSlash(handshakeUrl), sources: { ...sources }, problems };
  if (missing.length > 0) {
    resolved.off = `account sign-in isn't set up in this build (no ${missing.join(", ")})`;
    return resolved;
  }
  resolved.account = {
    authUrl: trimSlash(values.authUrl!),
    anonKey: anonKey!,
    serviceUrl: trimSlash(values.serviceUrl!),
    ...(values.emailSignInUrl ? { emailSignInUrl: values.emailSignInUrl } : {}),
  };
  return resolved;
}

/** `account.json`'s settings, or none when it is absent or refused (with the reason in `problems`). */
function readAccountFile(home: string, problems: string[]): Map<AccountSetting, string> {
  const out = new Map<AccountSetting, string>();
  const path = join(home, ACCOUNT_CONFIG_FILE);
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    problems.push(`${ACCOUNT_CONFIG_FILE} can't be read${code ? ` (${code})` : ""}, so nothing in it was used`);
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push(`${ACCOUNT_CONFIG_FILE} isn't JSON, so nothing in it was used`);
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push(`${ACCOUNT_CONFIG_FILE} isn't a JSON object, so nothing in it was used`);
    return out;
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (!Object.hasOwn(ACCOUNT_SETTINGS, k)) {
      // Never its value, and its name only when it looks like a setting's: a token or secret put here by mistake
      // must not reach a log either.
      const named = NAMEABLE_KEY.test(k) ? `a key it doesn't take ("${k}")` : "an unexpected key";
      problems.push(`${ACCOUNT_CONFIG_FILE} has ${named}, so nothing in it was used; it takes only ${Object.keys(ACCOUNT_SETTINGS).join(", ")}, and secrets belong in the secret store`);
      return new Map();
    }
    if (typeof v !== "string") {
      problems.push(`${ACCOUNT_CONFIG_FILE}'s ${k} isn't a string, so nothing in it was used`);
      return new Map();
    }
    if (v !== "") out.set(k as AccountSetting, v);
  }
  return out;
}

/** Why a URL isn't taken, or undefined: https only, or http to a loopback address where that is allowed. */
function badUrl(value: string, loopbackHttp: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a URL";
  }
  if (url.username || url.password) return "a URL with credentials";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!loopback) return "not https";
    return loopbackHttp ? undefined : "plain http to this machine is for dev and test builds only";
  }
  return "not https";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface WaifucaveAccountOptions {
  home: string;
  store: SecretStore;
  clock: { now(): number };
  env?: Record<string, string | undefined>;
  /** Tests only, as `resolveAccountConfig`'s: the daemon leaves it to the compile-time `DIST_BUILD`. */
  distBuild?: boolean;
  fetch?: (req: Request) => Promise<Response>;
  log?(line: string): void;
}

export interface WaifucaveAccount {
  /** The account client, when the account is set up; its session stays in the secret store. */
  account?: AccountClient;
  /** Short codes' slots at the handshake. */
  rendezvous: PairingRendezvous;
  /** The handshake's origin, for the links' `HandshakeClient`. */
  handshakeUrl: string;
  config: ResolvedAccountConfig;
}

/** What the daemon hands its links (`startDeviceLinks`'s `account`, `rendezvous` and handshake): built from the
 *  settings above, with this device's key from the secret store (the same key the links load). */
export async function waifucaveAccount(o: WaifucaveAccountOptions): Promise<WaifucaveAccount> {
  const log = o.log ?? ((l: string) => console.error(l));
  const config = resolveAccountConfig({ home: o.home, ...(o.env ? { env: o.env } : {}), ...(o.distBuild !== undefined ? { distBuild: o.distBuild } : {}), log });
  for (const p of config.problems) log(`[account] ${p}`);
  if (config.off) log(`[account] ${config.off}: this device runs signed out`);
  const rendezvous = new HandshakeRendezvous({ baseUrl: config.handshakeUrl, ...(o.fetch ? { fetch: o.fetch } : {}) });
  if (!config.account) return { rendezvous, handshakeUrl: config.handshakeUrl, config };
  const device = await DeviceKey.loadOrCreate(o.store);
  const account = new AccountClient({ config: config.account, store: o.store, device, clock: o.clock, ...(o.fetch ? { fetch: o.fetch } : {}) });
  return { account, rendezvous, handshakeUrl: config.handshakeUrl, config };
}
