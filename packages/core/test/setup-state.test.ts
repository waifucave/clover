import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import type { SetupState } from "@waifucave/moss-protocol";
import { recommendedModel } from "../src/default-model";
import { SetupService } from "../src/setup-state";

const catalog = loadCatalog();

function world(start: { stored?: string; present?: string[]; failRead?: boolean } = {}) {
  const s = { stored: start.stored, present: new Set(start.present ?? []), dismissed: false, failRead: start.failRead === true, writes: [] as string[], events: [] as SetupState[] };
  const service = new SetupService({
    readPresent: async () => {
      if (s.failRead) throw new Error("locked");
      return new Set(s.present);
    },
    storedModel: () => s.stored,
    recommend: (p) => recommendedModel(catalog, p),
    writeModel: (m) => { s.stored = m; s.writes.push(m); },
    dismissed: () => s.dismissed,
    writeDismissed: (d) => { s.dismissed = d; },
    offered: (m) => catalog.models.some((r) => r.key === m),
    emit: (state) => s.events.push(state),
    log: () => {},
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
    expect(st).toMatchObject({ ready: true, missing: [], providers: ["anthropic"], default: { model: rec, source: "chosen" } });
    expect(s.events.at(-1)).toEqual(st);
  });

  test("two providers and nothing chosen: the person picks; the pick is kept, and a provider outside the set is refused", async () => {
    const { s, service } = world({ present: ["anthropic", "openai"] });
    const st = await service.refresh();
    expect(st).toMatchObject({ ready: false, missing: ["model"] });
    expect(st.recommended?.anthropic).toBe(recommendedModel(catalog, "anthropic")!);
    await expect(service.setDefault("google/gemini-2.5-pro")).rejects.toThrow(/add google first/);
    const picked = await service.setDefault("openai/gpt-4.1");
    expect(picked).toMatchObject({ ready: true, default: { model: "openai/gpt-4.1", source: "chosen" } });
    expect(s.stored).toBe("openai/gpt-4.1");
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

  test("skipping is remembered and can be undone", async () => {
    const { service } = world();
    expect(service.dismiss(true).dismissed).toBe(true);
    expect(service.dismiss(false).dismissed).toBe(false);
  });
});
