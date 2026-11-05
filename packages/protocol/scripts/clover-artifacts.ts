// Clover's generated protocol artifacts (spec revision 17), under `generated/clover/`: one JSON file per area with
// each method's params and result schemas and each event's schema, one fixture per event, and every role's allow
// list. `generate.ts` writes them; `test/clover-generated.test.ts` checks the committed copies are current, so a
// change to an area file without `pnpm protocol:generate` fails the tests as well as CI's codegen job.
// Nothing here goes into the Swift test bundle: the inherited Swift mirror stays as it is until lane I re-points
// the iOS app.
import { z } from "zod";
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
    ...(m.change !== undefined ? { change: m.change } : {}),
    params: schemaOf(m.params, "input"),
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
  files.set("allowlists.json", json(Object.fromEntries(CLOVER_ROLES.map((role) => [role, {
    calls: [...allowedMethods(role)].sort(),
    receives: [...allowedEvents(role)].sort(),
    daemonSends: [...daemonRequestsTo(role)].sort(),
  }]))));
  return files;
}
