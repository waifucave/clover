// Winter Phase 9b — the codemod's rule corpus (P9b-1/P9b-8). Pure functions only; no git.
import { describe, expect, test } from "bun:test";
import { CLOVER_RULES, MOSS_RULES, entryAppliesTo, globToRegex, isExemptPath, pathStays, planMoves, renamePath, rewriteText, scaffoldPresent } from "./codemod";
import { EXPLICIT_TOKEN_MAP, RENAME_ALLOWLIST } from "./allowlist";
import { CLOVER_ALLOWLIST } from "./clover";
import { MOSS_ALLOWLIST } from "./moss";

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

  test("our four npm packages and (A-M1) the agent SDK's move to the waifucave scope; Winter's binary and router stay", () => {
    expect(cw('import { a } from "@yanlinglabs/winter-core"; import { b } from "@yanlinglabs/winter-agent-sdk";').out)
      .toBe('import { a } from "@waifucave/clover-core"; import { b } from "@waifucave/clover-agent-sdk";');
    expect(cw('"@yanlinglabs/winter-protocol" "@yanlinglabs/winter-cli" "@yanlinglabs/winter-plugin-sdk"').out)
      .toBe('"@waifucave/clover-protocol" "@waifucave/clover-cli" "@waifucave/clover-plugin-sdk"');
    // A-M1: clover-sdk 0.0.63 renamed the SDK's packages; the sweep is a rule, so it reapplies on any rebase.
    expect(cw('from "@yanlinglabs/winter-agent-runtime/embedded-host"; from "@yanlinglabs/winter-provider-runtime"; from "@yanlinglabs/winter-provider-catalog"').out)
      .toBe('from "@waifucave/clover-agent-runtime/embedded-host"; from "@waifucave/clover-provider-runtime"; from "@waifucave/clover-provider-catalog"');
    // ...but the coding-agent binary package (lane K's) and the archived router stay Winter's.
    expect(cw('"@yanlinglabs/winter-agent-sdk-darwin-arm64": "0.0.55"').out).toBe('"@yanlinglabs/winter-agent-sdk-darwin-arm64": "0.0.55"');
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
    const s = "import { WINTER_BRAND, resolveWinterHome as sdkResolveHome } from x; peers.winter; handoff.winterHome; WINTER_TEST_PROVIDER";
    expect(cw(s).out).toBe(s);
    expect(cw("const winterHome = home; f({ home: winterHome })").out).toBe("const cloverHome = home; f({ home: cloverHome })");
    // A-M1: the router's `handoff: { winterHome }` literal left with the router, so it renames like any field.
    expect(cw("handoff: { winterHome: home }").out).toBe("handoff: { cloverHome: home }");
  });

  test("Winter's coding agent and its binary keep their names", () => {
    expect(cw("Winter's coding agent: the `winter` binary, `bun run build:winter`, dist/winter").out)
      .toBe("Winter's coding agent: the `winter` binary, `bun run build:winter`, dist/winter");
  });

  test("history and other products' names stay: Winter's phases, the helpers, the extension", () => {
    const s = "Winter Phase 10a; Winter for Chrome; Winter Computer Use.app";
    expect(cw(s).out).toBe(s);
    // The helpers' bundle ids stay only in the files that build, sign and drive those helpers (C0 review S3).
    const ids = "com.winter.computeruse; com.winter.ant";
    expect(cw(ids, "packages/core/src/computer-use/protocol.ts").out).toBe(ids);
    expect(cw(ids).out).toBe("com.clover.computeruse; com.clover.ant");
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


// ── Clover→MOSS (`--rules moss`, the default) ───────────────────────────────────────────────────
describe("moss rules — what renames, what the app takes its own name for, and what the allowlist keeps", () => {
  const mw = (s: string, path = "packages/core/src/x.ts") => rewriteText(s, path, MOSS_RULES);

  test("the shape rule: the brand in prose is MOSS, an identifier part is Moss, a lower or upper token follows its case", () => {
    expect(mw("Clover is great. Clover's mark; quit Clover.").out).toBe("MOSS is great. MOSS's mark; quit MOSS.");
    expect(mw("CloverHome cloverHome CLOVER_HOME clover-core isCloversOwn").out).toBe("MossHome mossHome MOSS_HOME moss-core isMossOwn");
    expect(mw("`~/.clover` and CLOVER_PROFILE=dev").out).toBe("`~/.moss` and MOSS_PROFILE=dev");
    // A word after an escape is still a word.
    expect(mw("\\nClover said").out).toBe("\\nMOSS said");
  });

  test("the app takes the name MOSS Code only for its own identity: bundle, dev build, executable, installer and archive names", () => {
    expect(mw("/Applications/Clover.app Clover Dev.app Clover.exe Clover-Setup-1.exe Clover-1.2.3.dmg waifucave.Clover").out)
      .toBe("/Applications/MOSS Code.app MOSS Code Dev.app MOSS Code.exe MOSS-Code-Setup-1.exe MOSS-Code-1.2.3.dmg waifucave.MOSSCode");
    expect(mw("/opt/Clover/clover").out).toBe("/opt/moss-code/moss-code"); // never a space on Linux
    expect(mw("Application Support/Clover  %APPDATA%\\Clover  Program Files\\Clover").out)
      .toBe("Application Support/MOSS Code  %APPDATA%\\MOSS Code  Program Files\\MOSS Code");
  });

  test("identities: the app is com.waifucave.moss.code, the engine com.waifucave.moss.core, the bare moss id is never produced", () => {
    expect(mw("com.waifucave.clover com.waifucave.clover.dev com.waifucave.clover.dev.desktop com.waifucave.clover.ShipIt").out)
      .toBe("com.waifucave.moss.code com.waifucave.moss.code.dev com.waifucave.moss.code.dev.desktop com.waifucave.moss.code.ShipIt");
    expect(mw("com.waifucave.clover.core com.waifucave.clover.core.dev com.waifucave.clover.core.test-isolated com.waifucave.clover.core.scratch com.waifucave.clover.plugin-bun").out)
      .toBe("com.waifucave.moss.core com.waifucave.moss.core.dev com.waifucave.moss.core.test-isolated com.waifucave.moss.core.scratch com.waifucave.moss.core.plugin-bun");
    expect(mw("com.waifucave.clover.ios com.waifucave.clover.ios.test").out).toBe("com.waifucave.clover.ios com.waifucave.clover.ios.test"); // the iOS app's own, kept
    for (const id of ["com.waifucave.clover", "com.waifucave.clover.dev", "com.waifucave.clover.core", "com.waifucave.clover.helper"]) {
      expect(mw(id).out).not.toMatch(/com\.waifucave\.moss(?![.\w])/);
    }
  });

  test("packages, slugs and the SDK's names", () => {
    expect(mw('"@waifucave/clover-core" "@waifucave/clover-protocol" waifucave/clover').out).toBe('"@waifucave/moss-core" "@waifucave/moss-protocol" waifucave/moss');
    // The agent SDK's packages are installed from the registry under its own names, and its repo and result key are its own.
    const sdk = 'import { a } from "@waifucave/clover-agent-sdk"; "@waifucave/clover-agent-runtime/mcp-auth" waifucave/clover-sdk waifucave/clover-ios';
    expect(mw(sdk).out).toBe(sdk);
    expect(mw('_meta["clover/load"]', "packages/core/src/runtime-sdk/turn-loop/glossary.ts").out).toBe('_meta["clover/load"]');
    expect(mw('x["clover/load"]').out).toBe('x["moss/load"]'); // only where the SDK reads it
  });

  test("the old names a user wrote are kept where the one helper reads them, and renamed anywhere else", () => {
    const s = 'export const OLD_PROJECT_DIR = ".clover"; export const OLD_INSTRUCTIONS_FILE = "CLOVER.md"; export const OLD_PLUGIN_MANIFEST = "clover.json";';
    expect(mw(s, "packages/core/src/old-names.ts").out).toBe(s);
    expect(mw(s).out).toBe('export const OLD_PROJECT_DIR = ".moss"; export const OLD_INSTRUCTIONS_FILE = "MOSS.md"; export const OLD_PLUGIN_MANIFEST = "moss.json";');
  });

  test("the plant is Alpha's, in its own files", () => {
    expect(mw("const clover = leaf(); // a clover meadow", "plugins/alpha/client/meadow-art.ts").out).toBe("const clover = leaf(); // a clover meadow");
    expect(mw("const clover = leaf();", "plugins/sidebar/client/x.ts").out).toBe("const moss = leaf();");
  });

  test("paths: the plugin tree, the brand folder, the cask and the winget ids take the new names", () => {
    expect([
      renamePath("plugins/clover/plugins/x/clover.json", MOSS_RULES),
      renamePath("assets/brand/clover/a.svg", MOSS_RULES),
      renamePath("packaging/clover.rb.tmpl", MOSS_RULES),
      renamePath("packaging/winget/waifucave.Clover.yaml.tmpl", MOSS_RULES),
      renamePath("CLOVER.md", MOSS_RULES),
    ]).toEqual(["plugins/moss/plugins/x/moss.json", "assets/brand/moss-code/a.svg", "packaging/moss-code.rb.tmpl", "packaging/winget/waifucave.MOSSCode.yaml.tmpl", "MOSS.md"]);
  });

  test("exempt paths are left byte for byte; a doubled name is reported; a second pass changes nothing", () => {
    const s = "Clover clover CLOVER ~/.clover";
    expect(mw(s, "spikes/s1/README.md").out).toBe(s);
    expect(mw(s, "docs/research/x.md").out).toBe(s);
    expect(mw("moss-clover").doubleWinter.length).toBeGreaterThan(0);
    const once = mw("CLOVER_HOME cloverHome com.waifucave.clover /Applications/Clover.app @waifucave/clover-core").out;
    expect(mw(once).out).toBe(once);
  });

  test("allowlist hygiene: ids unique, every entry has a reason, file globs are well formed", () => {
    const ids = MOSS_ALLOWLIST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of MOSS_ALLOWLIST) {
      expect(e.why.length).toBeGreaterThan(20);
      expect(e.regex.flags).toContain("g");
    }
  });
});
