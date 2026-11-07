// FIRST import, on purpose: ESM evaluates imports in order, so this module's body — one fresh temp root for
// this test process, `TMPDIR` pointed at it, the whole tree removed at exit — has run before anything below
// (or any test file) can call `os.tmpdir()`. See ./per-process-tmp.ts. Every `mkdtempSync(join(tmpdir(), …))`
// in this file therefore lands inside that root too.
import "./per-process-tmp";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_HOME_ENV } from "../src/legacy-names";
// Cowork fences can inspect file identity to reject hard-link aliases. Inject the coordination root
// before any fence is constructed so even metadata checks never probe the production user ledger.
process.env.WINTER_COWORK_COORDINATION_DIR = mkdtempSync(join(tmpdir(), "clover-test-cowork-coordination-"));
// Hermetic guard: tests must never touch the user's real ~/.config/git/ignore
// (global-gitignore.ts resolves its default path from XDG_CONFIG_HOME).
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "clover-test-xdg-"));
// Phase 8d (whole-branch review, Major 1): recovery step 8's `claude-resume-*` sweep deletes under
// `os.tmpdir()` by default; every daemon-booting test must sweep a throwaway root instead of the
// developer's real per-user tmpdir. `wiring.ts` reads this env seam behind the explicit dep.
process.env.CLOVER_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "clover-test-claude-resume-"));
// Phase 9c Migration B: `legacyHomeFor(profile)` resolves the legacy home from this env var. Since C0
// (review S2) nothing calls it on its own — a boot never looks for a legacy home, and only an explicit
// `clover migrate --from <path>` reads one — but the redirect stays, to a throwaway, guaranteed-empty
// directory for the WHOLE run (spawned children inherit it), as a second fence: no test may ever touch
// the developer's REAL legacy dev/dist home. A test that exercises Migration B passes its own
// `migration.legacyHome` to `startDaemon` (see `daemon-migration-boot.test.ts`).
process.env[LEGACY_HOME_ENV] = mkdtempSync(join(tmpdir(), "clover-test-legacy-home-"));
// Test-keychain-isolation fix: a real-binary e2e test's spawned `winter`/`claude` child resolves
// its OWN Keychain credential refs (`profile.ts`'s `keychainService()`, `runtime-sdk/keychain.ts`)
// against a REAL Keychain service (`com.waifucave.clover.core[.dev]`) — never the test's own injected
// `FileSecretStore`, which only the daemon's IN-PROCESS reads go through. `keychainService()` only
// ever honours this override for a NON-default `CLOVER_HOME` (P9c-15's `isDefaultCloverHome` guard),
// so setting it here is inert for anyone running against a real `~/.clover[-dev]` home and active
// only for these tests' own temp homes. The named service has NO items — a lookup misses instantly
// instead of blocking on a macOS Keychain consent dialog or, worse, reading the user's real
// `openai:default`/`codex-oauth:default`/`anthropic:default` material.
process.env.CLOVER_KEYCHAIN_SERVICE = "com.waifucave.clover.core.test-isolated";
// macOS: and this process's own throwaway keychain FILE, the only keychain a test may reach (./test-keychain.ts).
await import("./test-keychain");
// C0 review (minor): the agent SDK reads its OWN variables whenever a call carries no brand (`runtime-sdk/brand.ts`):
// its home (`WINTER_HOME`) and temp root (`WINTER_TMPDIR`), which default to the live Winter install's folders, and
// its Keychain. Point both folders at throwaway ones and turn on the SDK's in-memory test Keychain, so a brandless
// call in a test lands in this run's temp root and never in that install's home or Keychain.
process.env.WINTER_HOME = mkdtempSync(join(tmpdir(), "clover-test-sdk-home-"));
process.env.WINTER_TMPDIR = mkdtempSync(join(tmpdir(), "clover-test-sdk-tmp-"));
process.env.WINTER_TEST_KEYCHAIN = "memory";
// The C0 check: an ambient `CLOVER_TMPDIR` (the developer's own) would take every session's scratch folder
// (`agent/session-tmp.ts`) out of this run's temp root. Unset here, so it falls back to `os.tmpdir()`, which is that
// root, for this process and every daemon it spawns; a test of the variable sets it itself.
delete process.env.CLOVER_TMPDIR;
// Login-shell PATH (`src/login-shell-path.ts`): every `startDaemon` boot resolves the user's login
// shell PATH by default. No test may run the developer's REAL login shell (their rc files, their
// agents) — this turns that off for every in-process boot AND every daemon subprocess a test spawns
// (they inherit `process.env`). A test that exercises the resolution injects a fake runner instead.
process.env.CLOVER_LOGIN_SHELL_PATH = "off";
// Usage tracking (`src/usage/wiring.ts`, docs/claude/usage.md): no test may read the developer's REAL Codex sessions,
// Claude Code transcripts or `~/.claude.json`, nor spawn their real `codex` / `claude` / `agy` / `opencode`. Every root
// points at an empty throwaway directory and every executable is "off" (authoritative: never a fall-through to $PATH).
// A test that exercises them injects fixture roots and a fake executable through `startDaemon({ usage })` or the
// service itself.
{
  const none = mkdtempSync(join(tmpdir(), "clover-test-usage-none-"));
  process.env.CLOVER_USAGE_CODEX_HOME = join(none, "codex");
  process.env.CLOVER_USAGE_CLAUDE_HOME = join(none, "claude");
  process.env.CLOVER_USAGE_CLAUDE_JSON = join(none, "claude.json");
  process.env.CLOVER_USAGE_CODEX_EXECUTABLE = "off";
  process.env.CLOVER_USAGE_CLAUDE_EXECUTABLE = "off";
  process.env.CLOVER_USAGE_AGY_EXECUTABLE = "off";
  process.env.CLOVER_USAGE_OPENCODE_EXECUTABLE = "off";
  // No background plan checks either (the 30-min beat, the alarms' fast beats): a test that wants them starts them.
  process.env.CLOVER_USAGE_BACKGROUND = "off";
}
// WS-21 (L3.5): saving an "in this project" answer appends to the user's GLOBAL git excludes, resolved
// through `git config --global core.excludesfile` (claude parity, `agent/git-exclude.ts`). No test may
// read or write the developer's real global git config, so every git a test (or a daemon it boots)
// spawns sees a throwaway one — with a test identity, so a test's own `git commit` keeps working.
{
  const gitHome = mkdtempSync(join(tmpdir(), "clover-test-gitconfig-"));
  const gitConfig = join(gitHome, ".gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = clover-test\n\temail = clover-test@example.invalid\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
}

// Guard (test-infra/fence-consumer-leak): the host-storage policy-consumer set is process-global, and a consumer left registered over a
// closed store makes every later `refreshHostStoragePolicies()` in the same process throw. Whoever registers one (a session-driver
// table, an embedded host, a daemon) must unregister it before the file ends.
import { afterAll } from "bun:test";
import { hostStoragePolicyConsumerCount, hostStoragePolicyConsumerOrigins } from "../src/runtime-sdk/host-storage-fence";
// Compiled-fixture children (`bun run fixture.ts`) load this preload outside the test runner, where `afterAll` throws: skip them.
try {
  afterAll(() => {
    const left = hostStoragePolicyConsumerCount();
    if (left > 0) throw new Error(`${left} host-storage policy consumer(s) left registered at the end of a test file; stop every daemon / drivers / embedded host the file creates. Registered from: ${hostStoragePolicyConsumerOrigins().join(" ; ")}`);
  });
} catch { /* not inside the test runner */ }

// A-M1 review (the SDK has no default brand): core installs CORE_BRAND as the SDK's process brand when it loads
// (`runtime-sdk/process-identity.ts`, through `src/index.ts`, `daemon.ts` and the CLI). A test that imports core
// piecemeal gets the same brand here, so an unthreaded SDK call reads Clover's names as it does in production.
// Imported dynamically, after the environment above is set: `CORE_BRAND` resolves its Keychain service from it.
{
  const { installBrand } = await import("@waifucave/clover-agent-sdk");
  const { CORE_BRAND } = await import("../src/runtime-sdk/brand");
  installBrand(CORE_BRAND);
}
