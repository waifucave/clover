// One at a time (spec §5.4, P4): a point a plugin declares may say `oneAtATime` with a title, on a list or keyed data
// point; `points.active` and `points.onActive` are both halves' calls, the second a watch.
import { expect, test } from "bun:test";
import { API_CALLS, LISTENER_ARGS, oneAtATimeOf, validateManifest } from "../src/index";

const errors = (m: Record<string, unknown>) => validateManifest(m, { folderName: "deck" }).issues.filter((i) => i.severity === "error").map((i) => i.code);
const FIELDS = { type: "object", properties: { id: { type: "string" } } };

test("a data point says it with a title; never a single point or a UI spot", () => {
  const host = (decl: Record<string, unknown>) => ({ manifest: 1, id: "deck", name: "Deck", engines: { moss: "^1.0.0" }, host: { entry: "host/index.ts", declares: { "deck.mode": { shape: "list", fields: FIELDS, ...decl } } } });
  expect(errors(host({ oneAtATime: true, title: { en: "Deck mode" } }))).toEqual([]);
  expect(errors(host({ oneAtATime: true }))).toEqual(["point_one_title"]);
  expect(errors(host({ oneAtATime: true, title: "Deck mode", shape: "single" }))).toEqual(["point_one_single"]);
  const spot = { manifest: 1, id: "deck", name: "Deck", engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx" }, contributes: { ui: [{ spot: "panel", id: "deck", component: "Deck", declares: { "deck.face": { shape: "list", props: {}, oneAtATime: true, title: "Face" } } }] } };
  expect(errors(spot)).toContain("point_one_spot");
});

test("its title for Settings' picker; points.active and points.onActive in both halves, onActive a watch", () => {
  expect(oneAtATimeOf("deck.mode", { oneAtATime: true, title: "Deck mode" })).toEqual({ title: "Deck mode" });
  expect(oneAtATimeOf("deck.mode", { oneAtATime: false, title: "Deck mode" })).toBeUndefined();
  // No core point is one at a time as shipped: they are plugins' own (MOSS Voice's voices).
  expect(oneAtATimeOf("computerProviders", undefined)).toBeUndefined();
  expect(oneAtATimeOf("models", undefined)).toBeUndefined();
  expect([API_CALLS["points.active"], API_CALLS["points.onActive"]]).toEqual([{ where: "both" }, { where: "both" }]);
  expect(LISTENER_ARGS["points.onActive"]).toEqual({ at: 1 });
});
