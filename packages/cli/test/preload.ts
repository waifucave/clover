// FIRST import, on purpose — see packages/core/test/per-process-tmp.ts: one fresh temp root for this test
// process, `TMPDIR` pointed at it, the whole tree removed at exit.
import "../../core/test/per-process-tmp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { LEGACY_HOME_ENV } from "@waifucave/clover-core";
// Cowork-aware host fences must never inspect the user's shared coordination ledger or Git
// configuration during private daemon/client fixtures. Match the core package test isolation.
process.env.WINTER_COWORK_COORDINATION_DIR = mkdtempSync(join(tmpdir(), "clover-test-cowork-coordination-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "clover-test-xdg-"));
// Ink's own <Text dimColor>/<Text inverse> render through chalk's default (shared, singleton)
// export, whose color LEVEL chalk auto-detects from `process.stdout` at first import — 0 whenever
// stdout isn't a real TTY, which is every `bun test` process, with or without FORCE_COLOR (that env
// var's OWN effective level then depends on COLORTERM, so it is 1 on a bare CI box but 3 on a dev
// machine with `COLORTERM=truecolor` — not deterministic either way). At level 0 chalk's
// `applyStyle` drops modifier codes (dim, inverse, bold, …) same as it drops color, so ink-testing-
// library frames silently lose their inverse-video cursor and dimmed hint text. Every place THIS
// package colors text itself already sidesteps the same detection by constructing its own
// `new Chalk({ level: 3 })` (src/tui/{app,composer,markdown,flatten-blocks}.tsx); pin the shared
// singleton chalk (and so Ink) to the same level, so the two never disagree and a plain `bun test`
// renders byte-identical frames to `FORCE_COLOR=1 bun test` regardless of the host terminal.
chalk.level = 3;
// Phase 8d (whole-branch review, Major 1): the CLI tests that spawn `daemon run` inherit this env, so
// the daemon's `claude-resume-*` sweep (recovery step 8) reads a throwaway root, never the developer's
// real per-user tmpdir — the same seam packages/core/test/preload.ts sets for core's own tests.
process.env.CLOVER_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "clover-test-claude-resume-"));
// Phase 9c Migration B: the SAME redirect packages/core/test/preload.ts sets, for the identical
// reason — since C0 (review S2) a boot never looks for a legacy home, but the redirect stays as a
// second fence, to a throwaway, guaranteed-empty directory for the whole run (spawned children
// inherit it), so nothing a test runs can resolve the developer's REAL legacy dev/dist home.
process.env[LEGACY_HOME_ENV] = mkdtempSync(join(tmpdir(), "clover-test-legacy-home-"));
// Test-keychain-isolation fix: the SAME redirect packages/core/test/preload.ts sets — a CLI test
// that spawns `daemon run` (or drives a real `clover`/`claude` child) inherits `process.env`, and
// `keychainService()` (`@waifucave/clover-core`) only ever honours this override for a
// NON-default `CLOVER_HOME` (P9c-15's guard), so it is inert against a real `~/.clover[-dev]` home
// and active only for these tests' own temp homes. The named service has no items.
process.env.CLOVER_KEYCHAIN_SERVICE = "com.waifucave.clover.core.test-isolated";
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
// Login-shell PATH: the SAME switch packages/core/test/preload.ts sets — a CLI test that spawns
// `daemon run` (or boots `startDaemon()` in-process) must never run the developer's real login shell.
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
