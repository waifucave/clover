// The bots' provider fill (A-M3, after INT's #257): a bot's model tag becomes the runtime's model, provider, credential
// resolver and model plugins, as a session's do, through the daemon's one broker, and only the model's own keys are set
// (the guarded `fillProvider` would refuse anything else).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@waifucave/clover-agent-sdk";
import { FileSecretStore } from "../../../src/auth/secret-store";
import { writeCredentialMaterial, writeOpenAiApiKey } from "../../../src/auth/credential-material";
import type { BotSessionContext } from "../../../src/bots/service";
import type { Settings } from "../../../src/settings";
import type { HostCredentialBroker, SessionCredentialAllowlist } from "../../../src/runtime-sdk/host-credentials";
import { CLOVER_CREDENTIAL_INVENTORY, credentialRefFor } from "../../../src/runtime-sdk/keychain";
import type { ModelPlugins } from "../../../src/runtime-sdk/model-plugins/service";
import { fillProvider } from "../../../src/runtime-sdk/turn-loop/embedded-session";
import { botProviderFill } from "../../../src/runtime-sdk/turn-loop/provider-fill";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

const ctx = { botId: "alpha", sessionId: "b_alpha", kind: "bot" } as unknown as BotSessionContext;

/** A broker that records the allowlist each session is given. */
function recordingBroker(): { broker: HostCredentialBroker; allowlists: SessionCredentialAllowlist[]; resolver: NonNullable<Options["onCredentialResolve"]> } {
  const allowlists: SessionCredentialAllowlist[] = [];
  const resolver = (async () => ({ status: "not_found" })) as unknown as NonNullable<Options["onCredentialResolve"]>;
  const broker = {
    resolverFor: (a: SessionCredentialAllowlist) => { allowlists.push(a); return resolver; },
    mcpRefresherFor: () => { throw new Error("a bot has no MCP sign-ins"); },
    generationOf: () => undefined,
  } as unknown as HostCredentialBroker;
  return { broker, allowlists, resolver };
}

test("a bot's model tag fills the model, its provider and locator, the shared broker's resolver and the model plugins, and nothing else", async () => {
  const home = temp("clover-a3-fill-home-");
  const secrets = new FileSecretStore(temp("clover-a3-fill-secrets-"));
  await writeOpenAiApiKey(secrets, "sk-test-not-real");
  const { broker, allowlists, resolver } = recordingBroker();
  const pluginsAsked: unknown[] = [];
  const modelProviders = { adapters: [] } as unknown as NonNullable<Options["modelProviders"]>;
  const modelPlugins = { sessionOption: (o: unknown) => { pluginsAsked.push(o); return modelProviders; } } as unknown as ModelPlugins;
  const fill = botProviderFill({ home, broker, secrets, modelPlugins: () => modelPlugins });
  const options: Options = { model: "openai/gpt-test-model", cwd: home, env: { CLOVER_HOME: home } };
  // Through the driver's guard: a fill that set anything but the model's own keys would throw here.
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, options);
  expect(options.model).toBe("gpt-test-model");
  expect(options.provider).toEqual({ providerId: "openai", authRef: credentialRefFor("openai", home)! });
  expect(options.onCredentialResolve).toBe(resolver);
  expect(options.modelProviders).toBe(modelProviders);
  expect(pluginsAsked).toEqual([{ caller: { kind: "core" }, session: "b_alpha" }]);
  // The broker answers the bot's provider's item and the slots of providers with a credential stored, nothing else.
  const openaiAccount = CLOVER_CREDENTIAL_INVENTORY.find((s) => s.provider === "openai")!.secretName;
  const anthropicAccount = CLOVER_CREDENTIAL_INVENTORY.find((s) => s.provider === "anthropic")!.secretName;
  expect(allowlists).toHaveLength(1);
  expect(allowlists[0]!.accounts.has(openaiAccount)).toBe(true);
  expect(allowlists[0]!.accounts.has(anthropicAccount)).toBe(false);
  expect(allowlists[0]!.mcpAccounts.size).toBe(0);
  // No secret anywhere in what was filled.
  expect(JSON.stringify(options)).not.toContain("sk-test-not-real");
});

test("the user's own endpoint for the provider travels as its connection, read at each fill", async () => {
  const home = temp("clover-a3-fill-home-");
  const secrets = new FileSecretStore(temp("clover-a3-fill-secrets-"));
  let settings: Settings | null = null;
  const fill = botProviderFill({ home, broker: recordingBroker().broker, secrets, settings: () => settings, modelPlugins: () => undefined });
  const first: Options = { model: "openai/gpt-test-model" };
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, first);
  expect(first.provider).toEqual({ providerId: "openai", authRef: credentialRefFor("openai", home)! });
  expect(first.modelProviders).toBeUndefined();
  settings = { providers: { openai: { baseUrl: "http://127.0.0.1:9/v1" } } } as unknown as Settings;
  const second: Options = { model: "openai/gpt-test-model" };
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, second);
  expect(second.provider).toEqual({ providerId: "openai", authRef: credentialRefFor("openai", home)!, connection: { baseUrl: "http://127.0.0.1:9/v1", endpointOrigin: "user", local: true } });
});

test("a test model and the unstated sentinel get nothing", async () => {
  const home = temp("clover-a3-fill-home-");
  const { broker, allowlists } = recordingBroker();
  const fill = botProviderFill({ home, broker, secrets: new FileSecretStore(temp("clover-a3-fill-secrets-")), modelPlugins: () => undefined });
  const test: Options = { model: "winter-test/echo" };
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, test);
  expect(test).toEqual({ model: "winter-test/echo" });
  const unstated: Options = { model: "unstated/unstated" };
  await fill("unstated/unstated", unstated, ctx);
  expect(unstated).toEqual({ model: "unstated/unstated" });
  expect(allowlists).toHaveLength(0);
});

test("a bot's allowlist is its own provider, the user's default's and the ones approved for it: never every key the user holds", async () => {
  const home = temp("clover-a3-fill-home-");
  const secrets = new FileSecretStore(temp("clover-a3-fill-secrets-"));
  const slot = (provider: string) => CLOVER_CREDENTIAL_INVENTORY.find((s) => s.provider === provider)!.secretName;
  // The user keeps keys for four providers.
  for (const p of ["openai", "anthropic", "groq", "mistral"]) await writeCredentialMaterial(secrets, slot(p), { kind: "api-key", key: `key-${p}-not-real` });
  const asked: [string, string][] = [];
  const approved = new Set(["groq"]);
  const { broker, allowlists } = recordingBroker();
  const fill = botProviderFill({
    home, broker, secrets, modelPlugins: () => undefined,
    defaultModel: () => "anthropic/claude-sonnet-5-5",
    approved: (c, provider) => { asked.push([c.botId, provider]); return approved.has(provider); },
  });
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, { model: "openai/gpt-test-model" });
  const accounts = allowlists[0]!.accounts;
  expect(accounts.has(slot("openai"))).toBe(true); // the bot's own
  expect(accounts.has(slot("anthropic"))).toBe(true); // the user's default
  expect(accounts.has(slot("groq"))).toBe(true); // approved for this bot
  expect(accounts.has(slot("mistral"))).toBe(false); // held, never approved
  expect(asked.every(([bot]) => bot === "alpha")).toBe(true);

  // An approval taken back, and no default: only the bot's own provider is left.
  approved.clear();
  const narrow = botProviderFill({ home, broker, secrets, modelPlugins: () => undefined, approved: (_c, p) => approved.has(p) });
  await fillProvider({ provider: (m, o) => narrow(m, o, ctx) }, { model: "openai/gpt-test-model" });
  const left = [...allowlists[1]!.accounts].filter((a) => CLOVER_CREDENTIAL_INVENTORY.some((s) => s.secretName === a));
  expect(left).toEqual([slot("openai")]);

  // Without a session context (an in-process agent's fill), approvals can't be read: none count.
  await narrow("openai/gpt-test-model", { model: "openai/gpt-test-model" });
  expect([...allowlists[2]!.accounts].filter((a) => a === slot("groq") || a === slot("mistral"))).toEqual([]);
});
