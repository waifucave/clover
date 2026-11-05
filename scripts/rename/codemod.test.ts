// Winter Phase 9b — the codemod's rule corpus (P9b-1/P9b-8). Pure functions only; no git.
import { describe, expect, test } from "bun:test";
import { CLOVER_RULES, entryAppliesTo, globToRegex, isExemptPath, pathStays, planMoves, renamePath, rewriteText, scaffoldPresent } from "./codemod";
import { EXPLICIT_TOKEN_MAP, RENAME_ALLOWLIST } from "./allowlist";
import { CLOVER_ALLOWLIST } from "./clover";

const rw = (s: string, path = "packages/core/src/x.ts") => rewriteText(s, path);

describe("generic pass — case preservation and traps", () => {
  test("the three cases", () => {
    expect(rw("norma Norma NORMA").out).toBe("winter Winter WINTER");
  });
  test("identifiers and possessives", () => {
    expect(rw("NormaKit normaHome resolveNormaHome Norma's NormaClient dotNorma").out)
      .toBe("WinterKit winterHome resolveWinterHome Winter's WinterClient dotWinter");
  });
  test("normal*/abnormal/normative are never brand tokens", () => {
    const s = "normal normally normalized normalize normalization normalisation abnormal normative Normal NORMAL Normative whatwgNormalize";
    const r = rw(s);
    expect(r.out).toBe(s);
    expect(r.generic).toBe(0);
    expect(r.residue).toHaveLength(0);
  });
  test("a trap next to a real token", () => {
    expect(rw("normalizeTypedInput(norma)").out).toBe("normalizeTypedInput(winter)");
  });
  test("mcp names, env names, dotted ids, paths", () => {
    expect(rw("mcp__norma__lsp__lsp NORMA_HOME com.norma.core ~/.norma-dev .norma/rules norma-core /usr/local/bin/norma").out)
      .toBe("mcp__winter__lsp__lsp WINTER_HOME com.winter.core ~/.winter-dev .winter/rules winter-core /usr/local/bin/winter");
  });
});

describe("explicit map (P9b-8) — host/runtime vocabulary and SDK collisions", () => {
  test("every entry renames as a whole token", () => {
    for (const [from, to] of EXPLICIT_TOKEN_MAP) {
      const r = rw(`x ${from} y`);
      expect(r.out).toBe(`x ${to} y`);
      expect(r.doubleWinter).toHaveLength(0);
    }
  });
  test("NORMA_WINTER_EXECUTABLE never becomes WINTER_WINTER_EXECUTABLE", () => {
    const r = rw('process.env.NORMA_WINTER_EXECUTABLE ?? env["NORMA_WINTER_REQUIRE_BINARY"]');
    expect(r.out).toBe('process.env.WINTER_RUNTIME_EXECUTABLE ?? env["WINTER_RUNTIME_REQUIRE_BINARY"]');
    expect(r.doubleWinter).toHaveLength(0);
  });
  test("NORMA_BRAND becomes CORE_BRAND, not the SDK's WINTER_BRAND; the SDK's own stays", () => {
    expect(rw("import { WINTER_BRAND } from sdk; export const NORMA_BRAND = buildNormaBrand();").out)
      .toBe("import { WINTER_BRAND } from sdk; export const CORE_BRAND = buildCoreBrand();");
  });
  test("the two string values, and the hyphen-suffixed test dirs", () => {
    expect(rw('processLabel: "norma-winter", id: "com.norma.winter"').out).toBe('processLabel: "winter", id: "com.winter.runtime"');
    expect(rw('mkdtempSync(join(tmpdir(), "norma-winter-chat-e2e-"))').out).toBe('mkdtempSync(join(tmpdir(), "winter-chat-e2e-"))');
  });
  test("a longer identifier containing a key is not split", () => {
    expect(rw("normaToolNameForX normaIdentity").out).toBe("winterToolNameForX winterIdentity");
  });
  test("host/runtime pairs in one line stay distinct", () => {
    expect(rw("const normaId = winterToNormaRoutineId.get(winterId)").out).toBe("const hostId = runtimeToHostRoutineId.get(winterId)");
  });
});

describe("protection (P9b-5) — external infrastructure survives", () => {
  test("GitHub URLs, release assets, the raw feed — protected ONLY inside the frozen legacy feed since 9c (P9c-6)", () => {
    const s = 'url: "https://github.com/yanlingLabs/norma/releases/download/v1/Norma-1.zip" GH_REPO = "yanlingLabs/norma" raw.githubusercontent.com/yanlingLabs/norma/main/releases/appcast.xml';
    // Phase 9c renamed the GitHub repo to `yanlingLabs/winter`; in any ordinary file the old path
    // is now residue the codemod RENAMES (GitHub redirects it, but nothing live may spell it).
    const live = rw(s);
    expect(live.out).toBe('url: "https://github.com/yanlingLabs/winter/releases/download/v1/Winter-1.zip" GH_REPO = "yanlingLabs/winter" raw.githubusercontent.com/yanlingLabs/winter/main/releases/appcast.xml');
    expect(live.residue.filter((x) => x.permittedBy === "gh-repo")).toHaveLength(0);
    // The byte-frozen legacy feed keeps its historical enclosure URLs verbatim.
    const r = rw(s, "releases/appcast.xml");
    expect(r.out).toBe(s);
    expect(r.residue.every((x) => x.permittedBy === "gh-repo" || x.permittedBy === "frozen-norma-feed")).toBe(true);
    expect(r.residue.length).toBeGreaterThanOrEqual(3);
  });
  test("the iOS repo name after a slash survives; the iOS bundle id renames", () => {
    const r = rw("../norma-ios yanlingLabs/norma-ios com.yanlinglabs.norma-ios");
    expect(r.out).toBe("../norma-ios yanlingLabs/norma-ios com.yanlinglabs.winter-ios");
    expect(r.residue.map((x) => x.permittedBy)).toEqual(["ios-repo", "ios-repo"]);
  });
  test("infra credentials, the notary profile, the guard dir, the checkout dir", () => {
    const r = rw("com.norma.infra com.norma.cf norma-notary ~/norma-private/git-hooks 'Norma v2' ~/.ssh/norma-relay", "infra/relay/README.md");
    expect(r.out).toBe("com.norma.infra com.norma.cf norma-notary ~/norma-private/git-hooks 'Norma v2' ~/.ssh/norma-relay");
    expect(r.residue.every((x) => x.permittedBy !== "UNPERMITTED")).toBe(true);
  });
  test("crypto domain tags and the relay-config signing key service survive everywhere (P9b-28)", () => {
    const r = rw('domain: "norma-relay-config/1" proof: "norma-pair-proof/1" sas: "norma-pair-sas/1" service: "com.norma.config-key"', "apple/WinterProtocol/Sources/WinterProtocol/Pairing.swift");
    expect(r.out).toBe('domain: "norma-relay-config/1" proof: "norma-pair-proof/1" sas: "norma-pair-sas/1" service: "com.norma.config-key"');
    expect(r.residue.map((x) => x.permittedBy)).toEqual(["crypto-domain-tags", "crypto-domain-tags", "crypto-domain-tags", "config-key-keychain"]);
    expect(rw("norma-relay-config-thing").out).toBe("winter-relay-config-thing"); // no version suffix → not a tag
  });
  test("norma-relay is only protected under infra/", () => {
    expect(rw("norma-relay", "packages/core/src/x.ts").out).toBe("winter-relay");
  });
  test("an unprotected survivor is reported UNPERMITTED only when it cannot be rewritten (exempt path)", () => {
    const r = rewriteText("Norma 0.2.002 <enclosure url=…/norma/…>", "releases/appcast.xml");
    expect(r.changed).toBe(false);
    expect(r.residue.every((x) => x.permittedBy === "frozen-norma-feed")).toBe(true);
  });
  test("the rename tooling is exempt and permitted", () => {
    expect(isExemptPath("scripts/rename/codemod.ts")).toBe(true);
    expect(rewriteText("norma", "scripts/rename/allowlist.ts").residue[0]?.permittedBy).toBe("rename-tooling");
  });
  test("the legacy-names files are permitted by path", () => {
    expect(rewriteText('export const LEGACY_LAUNCHD_LABEL = "com.norma.core";', "packages/core/src/legacy-names.ts").residue[0]?.permittedBy).toBe("legacy-names");
    expect(rewriteText('static let launchdAgentLabel = "com.norma.core"', "apple/Winter/Sources/App/LegacyNames.swift").residue[0]?.permittedBy).toBe("legacy-names");
  });
});

describe("gates", () => {
  test("double-winter is reported", () => {
    const r = rw("winter-winter WinterWinter WINTER_WINTER winterWinterX");
    expect(r.doubleWinter.map((d) => d.match)).toEqual(["winter-winter", "WinterWinter", "WINTER_WINTER", "winterWinter"]);
  });
  test("idempotent: a second pass over the output changes nothing", () => {
    const first = rw("Norma norma NORMA NORMA_WINTER_EXECUTABLE github.com/yanlingLabs/norma normal");
    const second = rw(first.out);
    expect(second.changed).toBe(false);
    expect(second.out).toBe(first.out);
  });
});

describe("paths", () => {
  test("components rename case-preservingly; traps stay", () => {
    expect(renamePath("apple/NormaKit/Sources/NormaSessionKit/X.swift")).toBe("apple/WinterKit/Sources/WinterSessionKit/X.swift");
    expect(renamePath("examples/battery-limiter/norma-plugin.json")).toBe("examples/battery-limiter/winter-plugin.json");
    expect(renamePath("packages/core/src/normalize.ts")).toBe("packages/core/src/normalize.ts");
    expect(renamePath("packaging/norma.rb.tmpl")).toBe("packaging/winter.rb.tmpl");
  });
  test("planMoves: directories shallowest-first, re-derived after each move, then files", () => {
    const moves = planMoves([
      "apple/NormaKit/Sources/NormaSessionKit/A.swift",
      "apple/NormaKit/Package.swift",
      "apple/Norma/Support/Norma.entitlements",
      "packages/core/src/norma-dir.ts",
      "packages/core/src/normalize.ts",
    ]);
    expect(moves).toEqual([
      { from: "apple/Norma", to: "apple/Winter", kind: "dir" },
      { from: "apple/NormaKit", to: "apple/WinterKit", kind: "dir" },
      { from: "apple/WinterKit/Sources/NormaSessionKit", to: "apple/WinterKit/Sources/WinterSessionKit", kind: "dir" },
      { from: "apple/Winter/Support/Norma.entitlements", to: "apple/Winter/Support/Winter.entitlements", kind: "file" },
      { from: "packages/core/src/norma-dir.ts", to: "packages/core/src/winter-dir.ts", kind: "file" },
    ]);
  });
});

describe("scaffold refusal (P9b-2)", () => {
  test("a tracked top-level norma/ is detected; apple/Norma is not it", () => {
    expect(scaffoldPresent(["norma/norma/normaApp.swift", "apple/Norma/x"])).toBe(true);
    expect(scaffoldPresent(["apple/Norma/x", "norma-vs-cc-tools.md"])).toBe(false);
  });
});

describe("allowlist hygiene", () => {
  test("globs", () => {
    expect(globToRegex("infra/**").test("infra/relay/README.md")).toBe(true);
    expect(globToRegex("infra/**").test("packages/x")).toBe(false);
    expect(entryAppliesTo(RENAME_ALLOWLIST.find((e) => e.id === "infra-ssh-key")!, "infra/relay/oci.ts")).toBe(true);
  });
  test("ids unique", () => {
    const ids = RENAME_ALLOWLIST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Clover C0: Winter→Clover (`--rules clover`, the default) ──────────────────────────────────
describe("clover rules — what renames and what the allowlist keeps", () => {
  const cw = (s: string, path = "packages/core/src/x.ts") => rewriteText(s, path, CLOVER_RULES);

  test("the generic pass: three cases, identifiers, env, homes, binaries", () => {
    expect(cw("winter Winter WINTER resolveWinterHome WINTER_HOME ~/.winter-dev winter-core").out)
      .toBe("clover Clover CLOVER resolveCloverHome CLOVER_HOME ~/.clover-dev clover-core");
  });

  test("our four npm packages move to the waifucave scope; the SDK's packages stay", () => {
    expect(cw('import { a } from "@yanlinglabs/winter-core"; import { b } from "@yanlinglabs/winter-agent-sdk";').out)
      .toBe('import { a } from "@waifucave/clover-core"; import { b } from "@yanlinglabs/winter-agent-sdk";');
    expect(cw('"@yanlinglabs/winter-protocol" "@yanlinglabs/winter-cli" "@yanlinglabs/winter-plugin-sdk"').out)
      .toBe('"@waifucave/clover-protocol" "@waifucave/clover-cli" "@waifucave/clover-plugin-sdk"');
    expect(cw('"@yanlinglabs/winter-runtime-sdk": "0.0.16"').out).toBe('"@yanlinglabs/winter-runtime-sdk": "0.0.16"');
  });

  test("identities and repo slugs take Clover's own names, not a swapped word", () => {
    expect(cw("com.winter.app com.winter.app.dev com.winter.core com.winter.core.dev").out)
      .toBe("com.waifucave.clover com.waifucave.clover.dev com.waifucave.clover.core com.waifucave.clover.core.dev");
    expect(cw("github.com/yanlingLabs/winter github.com/yanlingLabs/winter-ios yanlingLabs/winter-agent-sdk").out)
      .toBe("github.com/waifucave/clover github.com/waifucave/clover-ios waifucave/clover-sdk");
    expect(cw("yanlingLabs/winter-runtime-sdk").out).toBe("yanlingLabs/winter-runtime-sdk"); // archived, stays
  });

  test("the SDK's API, fields and fixed env names stay", () => {
    const s = "import { WINTER_BRAND, resolveWinterHome as sdkResolveHome } from x; peers.winter; handoff: { winterHome: home }; WINTER_TEST_PROVIDER";
    expect(cw(s).out).toBe(s);
    expect(cw("const winterHome = home; f({ home: winterHome })").out).toBe("const cloverHome = home; f({ home: cloverHome })");
  });

  test("Winter's coding agent and its binary keep their names", () => {
    expect(cw("Winter's coding agent: the `winter` binary, `bun run build:winter`, dist/winter").out)
      .toBe("Winter's coding agent: the `winter` binary, `bun run build:winter`, dist/winter");
  });

  test("history and other products' names stay: Winter's phases, the helpers, the extension", () => {
    const s = "Winter Phase 10a; com.winter.computeruse; com.winter.ant; Winter for Chrome; Winter Computer Use.app";
    expect(cw(s).out).toBe(s);
  });

  test("the SDK's session-door option keeps its name where it is the SDK's, and only there", () => {
    const s = "({ ...opts, winterHome: storeHome, brand: CORE_BRAND })";
    expect(cw(s, "packages/core/src/runtime-sdk/sessions.ts").out).toBe(s);
    expect(cw(s).out).toBe("({ ...opts, cloverHome: storeHome, brand: CORE_BRAND })");
  });

  test("exempt paths are left byte for byte, and stay where they are", () => {
    for (const p of ["apple/WinterKit/Sources/WinterKit/X.swift", "docs/research/2026-11-03-x.md", "releases/winter/appcast.xml", "docs/claude/testing.md"]) {
      expect(cw("WINTER_HOME winter", p).out).toBe("WINTER_HOME winter");
      expect(isExemptPath(p, CLOVER_RULES)).toBe(true);
      expect(pathStays(p, CLOVER_RULES)).toBe(true);
    }
  });

  test("paths: moved case-preservingly, except the kept ones", () => {
    expect(renamePath("packages/core/src/winter-dir.ts", CLOVER_RULES)).toBe("packages/core/src/clover-dir.ts");
    expect(pathStays("scripts/build-winter.ts", CLOVER_RULES)).toBe(true);
    expect(planMoves(["scripts/build-winter.ts", "packages/core/test/winter-dir.test.ts", "apple/Winter/x.swift"], CLOVER_RULES))
      .toEqual([{ from: "packages/core/test/winter-dir.test.ts", to: "packages/core/test/clover-dir.test.ts", kind: "file" }]);
  });

  test("a doubled name is reported", () => {
    expect(cw("clover-winter").doubleWinter.length).toBeGreaterThan(0);
  });

  test("idempotent: a second pass over the output changes nothing", () => {
    const once = cw("WINTER_HOME winterHome com.winter.app @yanlinglabs/winter-core").out;
    expect(cw(once).out).toBe(once);
  });

  test("allowlist hygiene: ids unique, every entry has a reason, file globs are well formed", () => {
    const ids = CLOVER_ALLOWLIST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CLOVER_ALLOWLIST) {
      expect(e.why.length).toBeGreaterThan(20);
      expect(e.regex.flags).toContain("g");
    }
  });
});
