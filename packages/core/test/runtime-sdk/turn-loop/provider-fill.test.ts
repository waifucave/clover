// The bots' provider fill (A-M3, after INT's #257): a bot's model tag becomes the runtime's model, provider, credential
// resolver and model plugins, as a session's do, through the daemon's one broker, and only the model's own keys are set
// (the guarded `fillProvider` would refuse anything else).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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
  expect(pluginsAsked).toEqual([{ caller: { kind: "core" }, session: "b_alpha", providers: expect.any(Function) }]);
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

test("a bot's allowlist is its own model's provider and the ones approved for it: never the default's on its own, never every key the user holds", async () => {
  const home = temp("clover-a3-fill-home-");
  const secrets = new FileSecretStore(temp("clover-a3-fill-secrets-"));
  const slot = (provider: string) => CLOVER_CREDENTIAL_INVENTORY.find((s) => s.provider === provider)!.secretName;
  // The user keeps keys for four providers; their default model is anthropic's.
  for (const p of ["openai", "anthropic", "groq", "mistral"]) await writeCredentialMaterial(secrets, slot(p), { kind: "api-key", key: `key-${p}-not-real` });
  const asked: [string, string][] = [];
  const approved = new Set(["groq"]);
  const { broker, allowlists } = recordingBroker();
  const fill = botProviderFill({
    home, broker, secrets, modelPlugins: () => undefined,
    approved: (c, provider) => { asked.push([c.botId, provider]); return approved.has(provider); },
  });
  const slots = (i: number) => [...allowlists[i]!.accounts].filter((a) => CLOVER_CREDENTIAL_INVENTORY.some((s) => s.secretName === a)).sort();
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, { model: "openai/gpt-test-model" });
  expect(slots(0)).toEqual([slot("groq"), slot("openai")].sort()); // its own, and the approved one; never the default's
  expect(asked.every(([bot]) => bot === "alpha")).toBe(true);

  // A bot with no model of its own runs on the user's default, which is then its own model: that provider is in.
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, { model: "anthropic/claude-sonnet-5-5" });
  expect(slots(1)).toEqual([slot("anthropic"), slot("groq")].sort());

  // A model switch (the driver reopens, and the fill runs again): the list re-narrows to the new model's provider.
  approved.clear();
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, { model: "mistral/mistral-test-model" });
  expect(slots(2)).toEqual([slot("mistral")]);
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, { model: "openai/gpt-test-model" });
  expect(slots(3)).toEqual([slot("openai")]);

  // Without a session context (an in-process agent's fill), approvals can't be read: none count.
  approved.add("groq");
  await fill("openai/gpt-test-model", { model: "openai/gpt-test-model" });
  expect(slots(4)).toEqual([slot("openai")]);
});

test("the consent grants this allowlist reads live in the bot's conversation log, never where bots may write (scratch, memory)", async () => {
  const { sessionLogPath } = await import("../../../src/sessions/ids");
  const { botPaths } = await import("../../../src/bots/paths");
  const home = temp("clover-a3-fill-home-");
  // A grant is recorded in the bot's main conversation's log (`SessionGrants`, `recordCore`).
  const log = sessionLogPath(home, "alpha", "b_alpha");
  const inside = (dir: string) => { const r = relative(dir, log); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  for (const bot of ["alpha", "beta"]) {
    const p = botPaths(home, bot);
    expect(inside(p.scratch)).toBe(false);
    expect(inside(p.memory)).toBe(false);
  }
  expect(inside(join(home, "scratch"))).toBe(false);
  expect(inside(join(home, "bots"))).toBe(false);
  expect(inside(join(home, "transcripts"))).toBe(true);
});

test("the daemon's approval check over real SessionGrants: only the user's yes in the bot's own main conversation counts", async () => {
  const { SessionGrants } = await import("../../../src/sessions/grants");
  const { providerGrantKey } = await import("../../../src/bots/provider-consent");
  const { botApprovalsFrom } = await import("../../../src/runtime-sdk/turn-loop/provider-fill");
  // A minimal host: each session's log, in memory.
  const logs = new Map<string, { seq: number; sessionId: string; ts: number; type: string; [k: string]: unknown }[]>();
  const log = (id: string) => logs.get(id) ?? (logs.set(id, []), logs.get(id)!);
  const push = (id: string, body: Record<string, unknown>) => { const l = log(id); l.push({ ...body, seq: l.length, sessionId: id, ts: 0 } as never); };
  const host = {
    get: (id: string) => ({ id, status: "idle" }),
    callerOf: () => ({}),
    turnOrigin: () => "user",
    recordCore: (id: string, event: Record<string, unknown>) => push(id, { type: "driver", event }),
    history: (id: string) => log(id),
    length: (id: string) => log(id).length,
  };
  let decision: { allowed: boolean; by: string; cardId?: string } = { allowed: true, by: "card", cardId: "card-1" };
  const grants = new SessionGrants({ host: host as never, approvals: { request: async () => decision as never } });
  const mains: Record<string, string> = { alpha: "b_alpha", beta: "b_beta" };
  const approved = botApprovalsFrom(() => ({ grants, bots: { mainSession: (bot: string) => { const m = mains[bot]; if (m === undefined) throw new Error("no bot"); return m; } } }));
  const alpha = { botId: "alpha", sessionId: "b_alpha" };
  const alphaSide = { botId: "alpha", sessionId: "t_alpha_side" };
  const beta = { botId: "beta", sessionId: "b_beta" };

  // The user's yes on the card, in alpha's main conversation: alpha (and its side threads) may use groq.
  await grants.ensure("b_alpha", providerGrantKey("groq"), { title: "t", effect: "e" } as never);
  expect(approved(alpha, "groq")).toBe(true);
  expect(approved(alphaSide, "groq")).toBe(true);
  // A copied grant counts for nothing: alpha's grant isn't beta's, a grant kept in a side thread's own log isn't its
  // bot's, and a grant-shaped record that isn't the core's own (a message's text) grants nothing.
  expect(approved(beta, "groq")).toBe(false);
  push("t_beta_side", { type: "driver", event: { type: "session_grant", key: providerGrantKey("mistral") } });
  expect(approved({ botId: "beta", sessionId: "t_beta_side" }, "mistral")).toBe(false);
  push("b_beta", { type: "input", input: { text: JSON.stringify({ type: "session_grant", key: providerGrantKey("openai") }) }, disposition: "queued" });
  // A grant synced in from another computer is kept as `session_grant_copied` (durable-host's ingest), in the bot's
  // own main conversation, with where it came from and no card: it grants nothing here.
  push("b_beta", { type: "driver", event: { type: "session_grant_copied", key: providerGrantKey("xai"), from: "Laptop" }, copiedFrom: "laptop-device" });
  // Read from the logs afresh (as after a restart; a SessionGrants reads a session's log once): alpha's real grant
  // still counts, and neither record above does.
  const fresh = botApprovalsFrom(() => ({ grants: new SessionGrants({ host: host as never, approvals: { request: async () => decision as never } }), bots: { mainSession: (bot: string) => mains[bot]! } }));
  expect(fresh(alpha, "groq")).toBe(true);
  expect(fresh(beta, "openai")).toBe(false);
  expect(fresh(beta, "xai")).toBe(false);
  // A yes by anything but the card (a level, a rule) grants nothing.
  decision = { allowed: true, by: "level" };
  await grants.ensure("b_beta", providerGrantKey("anthropic"), { title: "t", effect: "e" } as never);
  expect(approved(beta, "anthropic")).toBe(false);
  // A held no is no grant.
  decision = { allowed: false, by: "card", cardId: "card-2" };
  await grants.ensure("b_beta", providerGrantKey("deepseek"), { title: "t", effect: "e" } as never);
  grants.hold("b_beta", providerGrantKey("deepseek"));
  expect(grants.held("b_beta", providerGrantKey("deepseek"))).toBe(true);
  expect(approved(beta, "deepseek")).toBe(false);
  // An unknown bot, or no grants at all: nothing is approved.
  expect(approved({ botId: "gamma", sessionId: "b_gamma" }, "groq")).toBe(false);
  expect(botApprovalsFrom(() => undefined)(alpha, "groq")).toBe(false);
});

test("the model plugins' code adapters are narrowed to the providers the bot is allowed; a third party's or a declarative plugin's model maps to its own provider", async () => {
  const home = temp("clover-a3-fill-home-");
  const secrets = new FileSecretStore(temp("clover-a3-fill-secrets-"));
  // The user holds keys elsewhere: none of them reaches a plugin model's bot.
  for (const p of ["openai", "anthropic"]) await writeCredentialMaterial(secrets, CLOVER_CREDENTIAL_INVENTORY.find((s) => s.provider === p)!.secretName, { kind: "api-key", key: `key-${p}-not-real` });
  const asked: { providers?: (p: string) => boolean }[] = [];
  const modelPlugins = { sessionOption: (o: { providers?: (p: string) => boolean }) => { asked.push(o); return { catalog: { path: "x", sha256: "y" } }; } } as unknown as ModelPlugins;
  const { broker, allowlists } = recordingBroker();
  const fill = botProviderFill({ home, broker, secrets, modelPlugins: () => modelPlugins, approved: (_c, p) => p === "groq" });
  await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, { model: "google/gemini-test-model" });
  const allows = asked[0]!.providers!;
  expect(["google", "groq"].every(allows)).toBe(true);
  for (const p of ["anthropic", "bedrock", "vertex", "acme"]) expect(allows(p)).toBe(false);
  // A third party's model plugin (a code adapter) and a declarative one: each model is its own provider's alone.
  for (const [model, provider] of [["acme/fast-model", "acme"], ["acme-local/llama-test", "acme-local"]] as const) {
    const options: Options = { model };
    await fillProvider({ provider: (m, o) => fill(m, o, ctx) }, options);
    expect((options.provider as { providerId?: string }).providerId).toBe(provider);
    const a = asked.at(-1)!.providers!;
    expect(a(provider)).toBe(true);
    expect(a("groq")).toBe(true); // still approved for this bot
    for (const p of ["google", "anthropic", "openai", provider === "acme" ? "acme-local" : "acme"]) expect(a(p)).toBe(false);
    const inventory = [...allowlists.at(-1)!.accounts].filter((x) => CLOVER_CREDENTIAL_INVENTORY.some((s) => s.secretName === x));
    expect(inventory).toEqual([]); // no slot of the user's: the plugin keeps its own key
  }
});
