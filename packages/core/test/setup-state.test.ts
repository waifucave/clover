import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import type { SetupState } from "@waifucave/moss-protocol";
import { defaultEffortFor, recommended, recommendedModel } from "../src/default-model";
import { readProviders, SetupService } from "../src/setup-state";

const catalog = loadCatalog();

// The world a boot sees: keychain slots (one may throw), and the plugins (absent until they open; their sign-ins and
// keyless providers once the model plugins have started). The service reads it the daemon's way (`readProviders`).
function world(start: { stored?: string; present?: string[]; failRead?: boolean; plugins?: "closed" | "opening" | "started"; pluginSignedIn?: string[]; keyless?: string[]; failedSlots?: number } = {}) {
  const s = {
    effort: undefined as string | undefined, stored: start.stored, present: new Set(start.present ?? []), dismissed: false, failRead: start.failRead === true,
    plugins: start.plugins ?? "started", pluginSignedIn: new Set(start.pluginSignedIn ?? []), keyless: new Set(start.keyless ?? []), failedSlots: start.failedSlots ?? 0,
    writes: [] as string[], clears: 0, events: [] as SetupState[], logs: [] as string[],
  };
  const auth = {
    signedInProviders: async () => new Set(s.pluginSignedIn),
    keylessProviders: () => new Set(s.keyless),
    modelPluginsReady: () => s.plugins === "started",
  };
  const service = new SetupService({
    readPresent: async () => {
      if (s.failRead) throw new Error("locked");
      return readProviders({
        presence: async () => ({ byProvider: Object.fromEntries([...s.present].map((p) => [p, "keychain" as const])), ...(s.failedSlots > 0 ? { failedProbes: s.failedSlots } : {}) }),
        auth: () => (s.plugins === "closed" ? undefined : auth),
      });
    },
    storedModel: () => s.stored,
    storedEffort: () => s.effort,
    recommend: (p) => recommended(catalog, p),
    effortFor: (m) => defaultEffortFor(catalog, m),
    writeModel: (m, e) => { s.stored = m; s.effort = e; s.writes.push(m); },
    clearModel: () => { s.stored = undefined; s.effort = undefined; s.clears++; },
    dismissed: () => s.dismissed,
    writeDismissed: (d) => { s.dismissed = d; },
    offered: (m) => catalog.models.some((r) => r.key === m),
    emit: (state) => s.events.push(state),
    log: (line) => s.logs.push(line),
  });
  return { s, service };
}

describe("SetupService", () => {
  test("a fresh home: a provider and a model missing, nothing written", async () => {
    const { s, service } = world();
    const st = await service.refresh();
    expect(st).toMatchObject({ ready: false, missing: ["provider", "model"], providers: [], dismissed: false });
    expect(st.default).toBeUndefined();
    expect(s.writes).toEqual([]);
  });

  test("one provider added: its recommended model is written as the default and the state says so", async () => {
    const { s, service } = world();
    await service.refresh();
    s.present.add("anthropic");
    const st = await service.refresh();
    const rec = recommendedModel(catalog, "anthropic")!;
    expect(s.writes).toEqual([rec]);
    expect(st).toMatchObject({ ready: true, missing: [], providers: ["anthropic"], default: { model: rec, source: "chosen", effort: "medium" } });
    expect(s.effort).toBe("medium");
    expect(s.events.at(-1)).toEqual(st);
  });

  test("two providers and nothing chosen: the person picks; the pick is kept, and a provider outside the set is refused", async () => {
    const { s, service } = world({ present: ["anthropic", "openai"] });
    const st = await service.refresh();
    expect(st).toMatchObject({ ready: false, missing: ["model"] });
    expect(st.recommended?.anthropic).toEqual({ model: recommendedModel(catalog, "anthropic")!, effort: "medium" });
    await expect(service.setDefault("google/gemini-2.5-pro")).rejects.toThrow(/add google first/);
    const picked = await service.setDefault("openai/gpt-4.1");
    expect(picked).toMatchObject({ ready: true, default: { model: "openai/gpt-4.1", source: "chosen" } });
    expect(s.stored).toBe("openai/gpt-4.1");
    // Not its family's default: no effort carried over.
    expect(s.effort).toBeUndefined();
  });

  test("an older build's written default with no credential for it: a home with one other provider moves to that one's", async () => {
    const { s, service } = world({ stored: "codex-oauth/gpt-5.6-sol", present: ["anthropic"] });
    const st = await service.refresh();
    expect(st.default?.model).toBe(recommendedModel(catalog, "anthropic")!);
    expect(s.stored).toBe(recommendedModel(catalog, "anthropic")!);
  });

  test("a home whose named default works is left alone", async () => {
    const { s, service } = world({ stored: "anthropic/claude-sonnet-5-5", present: ["anthropic"] });
    const st = await service.refresh();
    expect(st).toMatchObject({ ready: true, default: { model: "anthropic/claude-sonnet-5-5", source: "chosen" } });
    expect(s.writes).toEqual([]);
  });

  test("a failed read keeps the last set and writes nothing", async () => {
    const { s, service } = world({ stored: "anthropic/claude-sonnet-5-5", present: ["anthropic", "openai"] });
    await service.refresh();
    s.failRead = true;
    const st = await service.refresh();
    expect(st.providers).toEqual(["anthropic", "openai"]);
    expect(s.writes).toEqual([]);
  });

  // The reviewer's boot sequences: what an existing home sees at its first boot on this build.
  test("(a) a default on a plugin-served provider and one keychain key: nothing written before the plugins' read or after", async () => {
    const { s, service } = world({ stored: "acme/acme-large", present: ["anthropic"], plugins: "closed", pluginSignedIn: ["acme"] });
    const boot = await service.refresh();
    expect(boot).toMatchObject({ ready: true, default: { model: "acme/acme-large", source: "chosen" } });
    s.plugins = "opening";
    await service.refresh();
    s.plugins = "started";
    const after = await service.refresh();
    expect(after).toMatchObject({ ready: true, default: { model: "acme/acme-large", source: "chosen" } });
    expect(s.writes).toEqual([]);
    expect(s.stored).toBe("acme/acme-large");
  });

  test("(a') the plugin's sign-in really gone, on a complete read: kept on disk, not ready, signed out; back when it is", async () => {
    const { s, service } = world({ stored: "acme/acme-large", present: ["anthropic"] });
    const st = await service.refresh();
    expect(st).toMatchObject({ ready: false, missing: ["default-provider"], signedOut: "acme/acme-large" });
    expect(st.default).toBeUndefined();
    expect(service.defaultModel()).toBeUndefined();
    s.pluginSignedIn.add("acme");
    expect(await service.refresh()).toMatchObject({ ready: true, default: { model: "acme/acme-large", source: "chosen" } });
    expect(s.writes).toEqual([]);
  });

  test("(b) a default on a keyless local provider with no keys: ready, no guide, nothing written", async () => {
    const { s, service } = world({ stored: "ollama-local/llama3", keyless: ["ollama-local"] });
    const st = await service.refresh();
    expect(st).toMatchObject({ ready: true, missing: [], providers: [], default: { model: "ollama-local/llama3", source: "chosen" } });
    expect(service.defaultModel()).toBe("ollama-local/llama3");
    expect(s.writes).toEqual([]);
  });

  test("(c) one slot's probe failing: the read isn't complete, nothing is written, one log line with no secret", async () => {
    const { s, service } = world({ stored: "openai/gpt-4.1", present: ["anthropic"], failedSlots: 1 });
    const st = await service.refresh();
    await service.refresh();
    expect(s.writes).toEqual([]);
    expect(st).toMatchObject({ ready: true, default: { model: "openai/gpt-4.1" } });
    expect(s.logs.filter((l) => l.includes("isn't complete"))).toEqual(["[setup] the providers' read isn't complete (1 credential slot probe(s) failed): the default model is left as it is"]);
    // A fresh home in the same state: computed in memory, not written until a read is complete.
    const fresh = world({ present: ["anthropic"], failedSlots: 1 });
    expect((await fresh.service.refresh()).default).toMatchObject({ model: recommendedModel(catalog, "anthropic")!, source: "computed" });
    expect(fresh.s.writes).toEqual([]);
    fresh.s.failedSlots = 0;
    await fresh.service.refresh();
    expect(fresh.s.writes).toEqual([recommendedModel(catalog, "anthropic")!]);
  });

  test("(iii) the person removes the default's provider: the one left recommends the new default; with several, none", async () => {
    const { s, service } = world({ stored: "openai/gpt-4.1", present: ["openai", "anthropic"] });
    await service.refresh();
    s.present.delete("openai");
    await service.refresh();
    expect(s.stored).toBe("openai/gpt-4.1");
    await service.providerRemoved("openai");
    expect(s.stored).toBe(recommendedModel(catalog, "anthropic")!);
    const two = world({ stored: "openai/gpt-4.1", present: ["openai", "anthropic", "google"] });
    await two.service.refresh();
    two.s.present.delete("openai");
    const st = await two.service.providerRemoved("openai");
    expect(two.s.stored).toBeUndefined();
    expect(two.s.clears).toBe(1);
    expect(st).toMatchObject({ ready: false, missing: ["model"] });
  });

  test("a removal seen while the read isn't complete waits for the complete read", async () => {
    const { s, service } = world({ stored: "openai/gpt-4.1", present: ["anthropic"], plugins: "opening" });
    await service.providerRemoved("openai");
    expect(s.writes).toEqual([]);
    s.plugins = "started";
    await service.refresh();
    expect(s.stored).toBe(recommendedModel(catalog, "anthropic")!);
  });

  test("overlapping refreshes: one read at a time, one more read for those asked meanwhile, and an old read never settles", async () => {
    // A home with no default: one provider read (old) would write its recommendation; two (new) mean the person picks.
    const reads: { resolve: (r: { present: Set<string>; complete: boolean }) => void }[] = [];
    const writes: string[] = [];
    let stored: string | undefined;
    const service = new SetupService({
      readPresent: () => new Promise((resolve) => { reads.push({ resolve }); }),
      storedModel: () => stored, storedEffort: () => undefined,
      recommend: (p) => recommended(catalog, p), effortFor: (m) => defaultEffortFor(catalog, m),
      writeModel: (m) => { stored = m; writes.push(m); }, clearModel: () => { stored = undefined; },
      dismissed: () => false, writeDismissed: () => {}, offered: () => true, emit: () => {}, log: () => {},
    });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const first = service.refresh();
    await tick();
    // A second provider is added while the first read runs; two more refreshes are asked for it.
    const second = service.refresh();
    const third = service.refresh();
    await tick();
    expect(reads.length).toBe(1);
    // The old read (one provider) resolves: a newer refresh was asked, so it doesn't settle.
    reads[0]!.resolve({ present: new Set(["anthropic"]), complete: true });
    await tick();
    expect(writes).toEqual([]);
    // ONE more read, for both waiters; it sees both providers and writes nothing (the person picks).
    expect(reads.length).toBe(2);
    reads[1]!.resolve({ present: new Set(["anthropic", "openai"]), complete: true });
    const states = await Promise.all([first, second, third]);
    expect(reads.length).toBe(2);
    expect(writes).toEqual([]);
    expect(states.at(-1)).toMatchObject({ ready: false, missing: ["model"], providers: ["anthropic", "openai"] });
    // A lone refresh with nothing newer asked does settle.
    const lone = service.refresh();
    await tick();
    reads[2]!.resolve({ present: new Set(["anthropic"]), complete: true });
    await lone;
    expect(writes).toEqual([recommendedModel(catalog, "anthropic")!]);
  });

  test("skipping is remembered and can be undone", async () => {
    const { service } = world();
    expect(service.dismiss(true).dismissed).toBe(true);
    expect(service.dismiss(false).dismissed).toBe(false);
  });
});
