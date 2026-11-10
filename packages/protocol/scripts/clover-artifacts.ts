// Clover's generated protocol artifacts (spec revision 17), under `generated/clover/`: one JSON file per area with
// each method's params and result schemas and each event's schema, one fixture per event, and every role's allow
// list. `generate.ts` writes them; `test/clover-generated.test.ts` checks the committed copies are current, so a
// change to an area file without `pnpm protocol:generate` fails the tests as well as CI's codegen job.
// Nothing here goes into the Swift test bundle: the inherited Swift mirror stays as it is until lane I re-points
// the iOS app.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, cardAnswerSigningInput, cardHashInput } from "../src/approvals";
import { CLOVER_AREAS, AREA_EVENTS, AREA_METHODS, AREA_OWNERS, CORE_METHODS, allowedEvents, allowedMethods, daemonRequestsTo } from "../src/clover";
import { CLOVER_ROLES } from "../src/roles";
import type { EventSpec, MethodSpec } from "../src/rpc";

/** Params and events are what a sender writes (`input`: unknown keys are stripped, not refused); results are what
 *  the daemon sends back (`output`). */
function schemaOf(s: z.ZodType, io: "input" | "output"): unknown {
  return z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "any", io });
}

function methodDoc(m: MethodSpec) {
  return {
    doc: m.doc,
    owner: m.owner,
    direction: m.direction,
    roles: [...m.roles],
    ...(m.capability !== undefined ? { capability: m.capability } : {}),
    ...(m.userOnly ? { userOnly: true } : {}),
    ...(m.noSessions ? { noSessions: true } : {}),
    ...(m.change !== undefined ? { change: m.change } : {}),
    params: schemaOf(m.params, "input"),
    ...(m.roleParams !== undefined ? { roleParams: Object.fromEntries(Object.entries(m.roleParams).map(([r, s]) => [r, schemaOf(s!, "input")])) } : {}),
    result: schemaOf(m.result, "output"),
  };
}

function eventDoc(e: EventSpec) {
  return {
    doc: e.doc,
    owner: e.owner,
    scope: e.scope,
    roles: [...e.roles],
    ...(e.capability !== undefined ? { capability: e.capability } : {}),
    ...(e.transient ? { transient: true } : {}),
    schema: schemaOf(e.schema, "input"),
  };
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The canonical JSON (RFC 8785) a card's hash covers, pinned for every language that recomputes it (the iOS app):
 *  each `input` with the exact text `canonicalJson` gives and its SHA-256, and a signing input. */
function cardHashVectors() {
  const inputs: [string, unknown][] = [
    ["nulls", { b: null, a: [null, 1, { c: null }] }],
    ["slash", { path: "a/b/c", url: "https://example.com/x?y=1" }],
    ["non-ascii", { text: "héllo — ✓", 日本: "語", Ä: "ö" }],
    ["line-separators", { s: "a\u2028b\u2029c" }],
    ["emoji", { e: "😀", "😀": 1, z: "👩‍👩‍👧" }],
    // A lone surrogate hashes as U+FFFD, as Swift's strings hold it (review N6).
    ["lone-surrogate", { s: "a\ud800b", "\udc00": 1 }],
    ["control", { c: "\u0000\u001f\t\n\r\"\\" }],
    ["numbers", { max: 9007199254740991, ts: 1781270000000, neg: -1, half: 0.5, big: 1e21, small: 1e-7, zero: 0 }],
    ["nested-order", { b: { y: [3, { q: 1, p: 2 }], x: true }, a: false, A: "upper first" }],
  ];
  const card = {
    id: "card_0a1b2c3d4e5f60718293a4b5", kind: "tool", computer: "Studio", session: "s_alpha", bot: "alpha", origin: "user",
    issuedAt: 1781270000000, expiresAt: null, fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "git push", language: "sh" } },
    options: [{ id: "approve", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }],
  };
  const cardInput = cardHashInput(card as never);
  const cardHash = sha256(cardInput);
  return {
    doc: "canonicalJson is RFC 8785 (JCS): keys sorted by UTF-16 code units, strings and numbers as ECMAScript serializes them, no whitespace, with any lone surrogate first replaced by U+FFFD. A card's hash is SHA-256 over cardHashInput(card), lowercase hex. The lone-surrogate vector's input holds escapes a Swift string can't: decoded with U+FFFD in their place, it must give the same canonical text.",
    vectors: inputs.map(([name, input]) => ({ name, input, canonical: canonicalJson(input), sha256: sha256(canonicalJson(input)) })),
    card: { card, hashInput: cardInput, hash: cardHash },
    signing: {
      answer: { id: card.id, hash: cardHash, option: "approve", at: 1781270001000, children: ["luna/tarot-panel", "luna/deck"] },
      input: cardAnswerSigningInput({ id: card.id, hash: cardHash, option: "approve", at: 1781270001000, children: ["luna/tarot-panel", "luna/deck"] }),
    },
  };
}

/** Path (relative to `generated/clover/`) → file content. */
export function buildCloverArtifacts(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("core.json", json({
    area: "core", owner: "C",
    methods: Object.fromEntries(Object.values(CORE_METHODS).map((m) => [m.name, methodDoc(m)])),
    events: {},
  }));
  for (const area of CLOVER_AREAS) {
    const methods = Object.values(AREA_METHODS[area]) as MethodSpec[];
    const events = Object.values(AREA_EVENTS[area]) as EventSpec[];
    files.set(`${area}.json`, json({
      area, owner: AREA_OWNERS[area],
      methods: Object.fromEntries(methods.map((m) => [m.name, methodDoc(m)])),
      events: Object.fromEntries(events.map((e) => [e.type, eventDoc(e)])),
    }));
    for (const e of events) files.set(`fixtures/${e.type}.json`, json(e.fixture));
  }
  files.set("fixtures/card-hash-vectors.json", json(cardHashVectors()));
  files.set("allowlists.json", json(Object.fromEntries(CLOVER_ROLES.map((role) => [role, {
    calls: [...allowedMethods(role)].sort(),
    receives: [...allowedEvents(role)].sort(),
    daemonSends: [...daemonRequestsTo(role)].sort(),
  }]))));
  return files;
}
