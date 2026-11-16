// FIRST import, on purpose — see packages/core/test/per-process-tmp.ts: one fresh temp root for this test
// process, `TMPDIR` pointed at it, the whole tree removed at exit.
import "../../core/test/per-process-tmp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { LEGACY_HOME_ENV } from "@waifucave/moss-core";
// Cowork-aware host fences must never inspect the user's shared coordination ledger or Git
// configuration during private daemon/client fixtures. Match the core package test isolation.
process.env.WINTER_COWORK_COORDINATION_DIR = mkdtempSync(join(tmpdir(), "moss-test-cowork-coordination-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "moss-test-xdg-"));
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
process.env.MOSS_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "moss-test-claude-resume-"));
// Phase 9c Migration B: the SAME redirect packages/core/test/preload.ts sets, for the identical
// reason — since C0 (review S2) a boot never looks for a legacy home, but the redirect stays as a
// second fence, to a throwaway, guaranteed-empty directory for the whole run (spawned children
// inherit it), so nothing a test runs can resolve the developer's REAL legacy dev/dist home.
process.env[LEGACY_HOME_ENV] = mkdtempSync(join(tmpdir(), "moss-test-legacy-home-"));
// Test-keychain-isolation fix: the SAME redirect packages/core/test/preload.ts sets — a CLI test
// that spawns `daemon run` (or drives a real `moss`/`claude` child) inherits `process.env`, and
// `keychainService()` (`@waifucave/moss-core`) only ever honours this override for a
// NON-default `MOSS_HOME` (P9c-15's guard), so it is inert against a real `~/.moss[-dev]` home
// and active only for these tests' own temp homes. The named service has no items.
process.env.MOSS_KEYCHAIN_SERVICE = "com.waifucave.moss.core.test-isolated";
// macOS: and this process's own throwaway keychain FILE, the only keychain a test may reach.
await import("../../core/test/test-keychain");
// And `Bun.secrets` fenced as in core's preload: a call that would reach the user's own store throws.
(await import("../../core/src/auth/test-isolation")).guardBunSecrets();
// C0 review (minor): the agent SDK reads its OWN variables whenever a call carries no brand (`runtime-sdk/brand.ts`):
// its home (`WINTER_HOME`) and temp root (`WINTER_TMPDIR`), which default to the live Winter install's folders, and
// its Keychain. Point both folders at throwaway ones and turn on the SDK's in-memory test Keychain, so a brandless
// call in a test lands in this run's temp root and never in that install's home or Keychain.
process.env.WINTER_HOME = mkdtempSync(join(tmpdir(), "moss-test-sdk-home-"));
process.env.WINTER_TMPDIR = mkdtempSync(join(tmpdir(), "moss-test-sdk-tmp-"));
process.env.WINTER_TEST_KEYCHAIN = "memory";
// The C0 check: an ambient `MOSS_TMPDIR` (the developer's own) would take every session's scratch folder
// (`agent/session-tmp.ts`) out of this run's temp root. Unset here, so it falls back to `os.tmpdir()`, which is that
// root, for this process and every daemon it spawns; a test of the variable sets it itself.
delete process.env.MOSS_TMPDIR;
// Login-shell PATH: the SAME switch packages/core/test/preload.ts sets — a CLI test that spawns
// `daemon run` (or boots `startDaemon()` in-process) must never run the developer's real login shell.
process.env.MOSS_LOGIN_SHELL_PATH = "off";
// Usage tracking (`src/usage/wiring.ts`, docs/claude/usage.md): no test may read the developer's REAL Codex sessions or
// Claude Code transcripts, nor run their real `codex` / `claude` / `agy` / `opencode`. The sources are bundled plugins
// the daemon calls through `api.outside`; `off` calls none of them (authoritative: never a fall-through to the user's
// installs). A test that exercises a source injects a port and fake programs through `startDaemon({ usage })`.
{
  process.env.MOSS_USAGE_SOURCES = "off";
  // No background plan checks either (the 30-min beat, the alarms' fast beats): a test that wants them starts them.
  process.env.MOSS_USAGE_BACKGROUND = "off";
}
