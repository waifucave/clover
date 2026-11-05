import { describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type Options, type WinterMcpServerInstance } from "@waifucave/clover-agent-sdk";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import {
  CAPABILITY_SERVER_KEYS, CLOVER_CAPABILITY_TOOLS,
  assertNoCapabilityCollision, buildCapabilitiesFor, capabilityServerName, capabilityToolName,
  CapabilityNameCollisionError,
  type CapabilityDeps, type CapabilityServerRecord, type CapabilitySession,
} from "../../src/capabilities";

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * C1 / P8b-35 — THE WIRE NAMES, DERIVED RATHER THAN PASTED
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `names.test.ts` asserts that the table and `capabilityToolName` agree with each other. That is not
 * enough, and the reason is the defect this file exists to prevent: two copies of the same WRONG
 * string agree perfectly. The first cut of this batch declared its servers `name: "sessions"`, which
 * a child reaches as `mcp__sessions__list_sessions` — one segment short of every literal in the
 * table — and nothing failed anywhere, because Task 9's planned tripwire diffs
 * `CAPABILITY_TOOL_MODES` against `CLOVER_CAPABILITY_TOOLS`, i.e. copy against copy.
 *
 * So this file derives the name from THE SERVER OBJECT THE ROUTER RECEIVES, through the router's own
 * naming path, and asserts the derived name is the one the table carries. It fails on the old code
 * and passes on the new, which is the only property that makes the table trustworthy for Task 9 and
 * for P8b-25's `hostToolNameFor`.
 *
 * A-M1: the router and its handle-wide capability record are gone (spec §3.3). Every session carries
 * its capability servers in its own `Options.mcpServers`, keyed by each server's own `name` (P8b-36),
 * which is the path the tests below derive the wire name through.
 */

const SESSION: CapabilitySession = { sessionId: "s_wire", mode: "code", cwd: "/tmp", roots: ["/tmp"] };

/** Deps that reach no network, no store and no app — this file is about NAMES. */
function deps(): CapabilityDeps {
  const panel = { dispatch: () => ({ commandId: "c", settled: Promise.resolve({ kind: "timeout" as const, deadlineMs: 1 }) }), harnesses: () => [] };
  return {
    sessions: { models: [], sessions: { store: { list: () => [], lastEventTs: () => 0, transcriptPath: () => "" } } as never },
    computer: { computerUse: () => undefined },
    computerUseEnabled: () => true, // every server, so every name is covered
    browser: { browser: { tabs: () => ({ tabs: [], activeTabId: undefined }) as never, openTab: () => "t", ...panel } },
    office: { office: { ...panel, dirsOf: () => [] as never } },
    lsp: { lsp: () => undefined },
  };
}

/** ComputerV2 (2026-10-08): `computer` and `computer_v2` are never built together (`computerUse.legacyComputer`
 *  picks one), so "every server" is the union of the two builds — every key and every name stays covered. */
function serversFor(mode: CapabilitySession["mode"]): CapabilityServerRecord {
  return {
    ...buildCapabilitiesFor({ ...SESSION, mode }, deps()),
    ...buildCapabilitiesFor({ ...SESSION, mode }, { ...deps(), legacyComputer: () => true }),
  };
}

/**
 * THE LAST HOP (N1). P8b-36 hands the servers to the child through `Options.mcpServers`, and on that
 * path the wire name comes from the RECORD KEY, not from the config's `name` field:
 * `toWireMcpServers` iterates `Object.entries(servers)` and keys its output by that key, and
 * `makeSdkMcpCallHandler` dispatches `sdk_mcp_call` by `mcpServers[req.server]` — the key again.
 * This walks an `Options` object the way the SDK does, so the derivation covers the path 8b actually
 * takes rather than only the router's `capabilities` path.
 */
function wireNamesFromOptions(options: Pick<Options, "mcpServers">): string[] {
  const out: string[] = [];
  for (const [key, cfg] of Object.entries(options.mcpServers ?? {})) {
    if (cfg.type !== "sdk" || !isWinterMcpServerInstance(cfg.instance)) continue;
    // `toWireMcpServers` sends `tools: cfg.instance.listTools()` under this KEY; the child names
    // each of them `mcp__<key>__<tool>`.
    for (const tool of cfg.instance.listTools()) out.push(`mcp__${key}__${tool.name}`);
  }
  return out;
}

describe("P8b-35: the wire name a child sees is the name the table carries", () => {
  test("every server/tool pair derives to exactly its CLOVER_CAPABILITY_TOOLS key", () => {
    const derived = new Set<string>();
    // Across ALL THREE MODES, because P8b-37 now filters each server's tools by the session's mode —
    // no single session sees every tool, and the table describes the union.
    for (const mode of ["code", "dispatch", "chat"] as const) {
      const record = serversFor(mode);
      for (const key of CAPABILITY_SERVER_KEYS) {
        const server = record[capabilityServerName(key)];
        expect(server, `no capability server was built for key "${key}" in ${mode}`).toBeDefined();
        for (const tool of (server!.instance as WinterMcpServerInstance).listTools()) {
          // THE DERIVATION — the router's `mcp__<server>__<tool>`, built from the server object it is
          // handed, with nothing pasted. This is the assertion that fails if the brand segment is
          // not on the server's name.
          const wire = `mcp__${server!.name}__${tool.name}`;
          expect(wire).toBe(capabilityToolName(key, tool.name));
          expect(CLOVER_CAPABILITY_TOOLS, `${wire} is not in the table`).toHaveProperty(wire);
          derived.add(wire);
        }
      }
    }
    // And nothing in the table names a tool no session ever serves — a stale row would be a
    // `disallowedTools` entry that denies nothing, which is the same silent failure in reverse.
    expect([...derived].sort()).toEqual(Object.keys(CLOVER_CAPABILITY_TOOLS).sort());
  });

  test("N1: the same names come out of the `Options.mcpServers` path, walked as the SDK walks it", () => {
    const derived = new Set<string>();
    for (const mode of ["code", "dispatch", "chat"] as const) {
      // The record IS `Options.mcpServers` — spread, not re-keyed, which is the point of returning
      // a record at all. A driver that re-keyed it would show up right here.
      for (const wire of wireNamesFromOptions({ mcpServers: { ...serversFor(mode) } })) {
        expect(CLOVER_CAPABILITY_TOOLS, `${wire} is not in the table`).toHaveProperty(wire);
        derived.add(wire);
      }
    }
    expect([...derived].sort()).toEqual(Object.keys(CLOVER_CAPABILITY_TOOLS).sort());
  });

  test("A-M1 review M9: every advertised inputSchema is a JSON-Schema object (the check the router ran at construction)", () => {
    // The router's `capabilityServerDescriptors` called every `instance.listTools()` and refused any tool whose
    // `inputSchema` was not a JSON-Schema object; with the router gone, nothing between a capability server and
    // the child checks it, so this does, for every server in every mode.
    const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const problems: string[] = [];
    let checked = 0;
    for (const mode of ["code", "dispatch", "chat"] as const) {
      for (const [key, cfg] of Object.entries(serversFor(mode))) {
        for (const tool of (cfg.instance as WinterMcpServerInstance).listTools()) {
          checked++;
          const where = `${mode} ${key}/${tool.name}`;
          const schema: unknown = tool.inputSchema;
          if (!isPlain(schema)) { problems.push(`${where}: not an object`); continue; }
          if (schema["type"] !== "object") problems.push(`${where}: type is ${JSON.stringify(schema["type"])}, not "object"`);
          const props = schema["properties"];
          if (props !== undefined && (!isPlain(props) || !Object.values(props).every(isPlain))) problems.push(`${where}: properties is not an object of schemas`);
          const required = schema["required"];
          if (required !== undefined && (!Array.isArray(required) || !required.every((r) => typeof r === "string" && isPlain(props) && r in props))) problems.push(`${where}: required names a property it does not declare`);
          const extra = schema["additionalProperties"];
          if (extra !== undefined && typeof extra !== "boolean" && !isPlain(extra)) problems.push(`${where}: additionalProperties is neither a boolean nor a schema`);
          // It crosses the wire as JSON: nothing in it may be lost on the way.
          if (JSON.stringify(JSON.parse(JSON.stringify(schema))) !== JSON.stringify(schema)) problems.push(`${where}: not plain JSON`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });

  test("N1: every record KEY equals its config's own name — mis-keying is unrepresentable", () => {
    const record = serversFor("code");
    for (const [key, cfg] of Object.entries(record)) expect(key).toBe(cfg.name);
    expect(Object.keys(record).sort()).toEqual(CAPABILITY_SERVER_KEYS.map(capabilityServerName).sort());
  });

  test("the server name carries the brand, and can never shadow the standing messaging server", () => {
    for (const key of CAPABILITY_SERVER_KEYS) {
      const name = capabilityServerName(key);
      expect(name.startsWith("clover__")).toBe(true);
      // The one name the router REFUSES for a capability server (it would shadow the brand's own).
      expect(name).not.toBe("clover");
    }
  });

  test("a `clover`-less server name would produce the WRONG wire name — the defect this pins", () => {
    // The shape of the regression, stated as an assertion rather than a comment: had the server
    // been declared with the bare key, the derived name would be one segment short of the table's.
    for (const key of CAPABILITY_SERVER_KEYS) {
      expect(`mcp__${key}__x`).not.toBe(capabilityToolName(key, "x"));
    }
  });
});

describe("N2: assertNoCapabilityCollision — the guard the router no longer runs for us", () => {
  test("a caller's server colliding with a daemon-owned name is REFUSED, naming it", () => {
    const owned = serversFor("code");
    const plugin = { "clover__browser": { type: "sdk" as const, name: "clover__browser", instance: {} } };
    expect(() => assertNoCapabilityCollision(plugin, owned)).toThrow(CapabilityNameCollisionError);
    try {
      assertNoCapabilityCollision(plugin, owned);
    } catch (err) {
      expect((err as CapabilityNameCollisionError).server).toBe("clover__browser");
      expect((err as { code?: string }).code).toBe("capability_name_collision");
    }
  });

  test("fix-wave N-1: a configured server keyed exactly the BRAND NAME (`clover`) is refused — its tools would mint mcp__clover__<x> names Clover maps onto its own gate classes", () => {
    const owned = serversFor("code");
    // `clover` + a tool named `web__web_fetch` → `mcp__clover__web__web_fetch`, the very string the
    // bridge strips to Clover's `web_fetch` (NETWORK, silent under every policy incl. `plan`)
    expect(capabilityToolName("web", "web_fetch")).toBe(`mcp__${CORE_BRAND.mcpServerName}__web__web_fetch`);
    const spoof = { [CORE_BRAND.mcpServerName]: { type: "stdio" as const, command: "evil" } };
    expect(() => assertNoCapabilityCollision(spoof, owned)).toThrow(CapabilityNameCollisionError);
    try { assertNoCapabilityCollision(spoof, owned); } catch (err) {
      expect((err as CapabilityNameCollisionError).server).toBe("clover");
      expect((err as Error).message).toContain("the host's own MCP namespace");
    }
    // refused with an EMPTY owned set too (the brand rule does not depend on which servers this
    // session carries), and a merely similar key is not
    expect(() => assertNoCapabilityCollision(spoof, [])).toThrow(CapabilityNameCollisionError);
    expect(() => assertNoCapabilityCollision({ "clover-tools": {}, "normal": {} }, owned)).not.toThrow();
  });

  test("non-colliding servers, an empty record and `undefined` all pass", () => {
    const owned = serversFor("code");
    expect(() => assertNoCapabilityCollision({ "some-plugin": {} }, owned)).not.toThrow();
    expect(() => assertNoCapabilityCollision({}, owned)).not.toThrow();
    expect(() => assertNoCapabilityCollision(undefined, owned)).not.toThrow();
  });

  test("it accepts a bare name list as well as the record", () => {
    expect(() => assertNoCapabilityCollision({ "clover__web": {} }, ["clover__web"])).toThrow(CapabilityNameCollisionError);
    expect(() => assertNoCapabilityCollision({ "clover__web": {} }, ["clover__browser"])).not.toThrow();
  });
});

