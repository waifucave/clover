// THE SESSION HOST: the daemon's one handle around the agent SDK (spec §3.3: the daemon drives the SDK
// directly; the router is archived).
//
// It replaces the router's `createRuntimeSdk`, and keeps of it only what the daemon still needs:
//
//   * `query()`: the per-run home applied to the caller's own `Options`, then the SDK's own `query()`.
//     With `requireRunHome` (the daemon always sets it) a generation without a run home is refused
//     (`run_home_required`), so no session can run on the user's real home by accident.
//     `Options.runtime` (where the run home rides, Contract A) is taken off before the SDK sees the
//     options; nothing else is rewritten, except that the host's brand fills in `Options.brand` when
//     the caller set none.
//   * the runtime directory and the messaging router, built together (`messaging/`);
//   * the switch reviewer over the one shared transcript store (`reviewer`), and the crash-recovery
//     reconcile through the same store (`reconcileRootForRecovery`);
//   * each run home's outcome (`runHomeOutcome`): `pending` while its query runs, `safe` once it ends.
//
// What the router had and this does not: an injected `peers` object and the version matrix over it
// (the daemon imports the SDK itself and checks one version lock, `embedded.ts`'s
// `embeddedVersionCheck`), a selection carried inside `Options.runtime` (the daemon decides and
// persists selections itself, `create.ts`'s `selectRuntimeFor`), and capability servers merged into
// every query (each session carries its own `mcpServers`). `sdk` stays a parameter so a test can hand
// in a fake SDK and see exactly what the host passes it.
import * as cloverSdk from "@waifucave/clover-agent-sdk";
import type { BrandProfile, Options, Query } from "@waifucave/clover-agent-sdk";
import type { ContinuityEndpoint, MessageOrigin } from "@waifucave/clover-provider-runtime";

import { RuntimeSdkDisposedError, RuntimeSdkError } from "./errors";
import type { SeamContext, SeamContextWithDirectory } from "./seams/context";
import type { GlobalMessagingHandle } from "./messaging/router";
import type { RuntimeDirectory } from "./seams/directory";
import type { RuntimeDirectoryStore } from "./seams/directory-store";
import { createInMemoryRuntimeDirectoryStore } from "./seams/directory-store";
import { createRuntimeMessaging } from "./messaging/index";
import type { GlobalMessagingOptions, RuntimeDirectoryOptions } from "./messaging/index";
import { createSwitchReviewer, type SwitchReviewerHandle } from "./store/review-switch";
import { RunHomeError } from "./run-home/errors";
import { applyWinterRunHome, assertNoRunHomeDecidedOptions, assertRunHomeApplicable, observeQueryEnd } from "./run-home/apply";
import { reconcileRootForRecovery, type RecoveryReport } from "./run-home/exit";
import { defaultEndpointResolver } from "./default-endpoint-resolver";
import { sdkHomeOf, type RunHome, type RunHomeFor, type RunHomeOutcome } from "./run-home/types";

/** The agent SDK as the host uses it: its module namespace. Production passes nothing (the real one). */
export type HostSdk = typeof cloverSdk;

/** `Options` plus where the run home rides (Contract A: `options.runtime.runHome`). */
export interface HostQueryOptions extends Options {
  runtime?: { runHome?: RunHome };
}

export interface RuntimeSdkHostOptions {
  /**
   * The daemon's home: the quarantine and the shared store resolve under it. Required with
   * `requireRunHome`, whose store is rooted at `sdkHomeOf(home)`; absent, the SDK's own resolution
   * under `brand` decides (a bare test host).
   */
  home?: string;
  /**
   * WS-21 §3.1: every generation carries a run home, or it is refused (`run_home_required`). The
   * daemon sets it whenever it can build run homes; absent, a query may run without one and the
   * store is rooted at `home` itself (the pre-WS-21 layout, kept for the tests that pin it).
   */
  requireRunHome?: boolean;
  /** The SDK. Default: the one this package depends on; a test passes a fake. */
  sdk?: HostSdk;
  /**
   * The brand every SDK-owned name derives from, resolved once here through the SDK's own
   * `resolveBrand` (an invalid profile is a construction refusal, the SDK's `InvalidBrandError`). It
   * fills in `Options.brand` for a query that sets none; absent, the SDK's own defaults apply.
   */
  brand?: Partial<BrandProfile>;
  /** The durable directory (`runtime-state.db`); default in-memory (messaging works, receipts don't last). */
  directoryStore?: RuntimeDirectoryStore;
  /** The catalog-backed resolver the switch review reads continuity from; default `defaultEndpointResolver()`. */
  resolveEndpoint?: (origin: MessageOrigin) => ContinuityEndpoint;
  /** The directory's retention and the messaging router's options (a receiver's permission class). */
  messaging?: { directory?: RuntimeDirectoryOptions; messaging?: GlobalMessagingOptions };
  /** The host's run-home builder, for the messaging router's own cold resume of a parked session. */
  runHomeFor?: RunHomeFor;
}

export interface RuntimeSdkHost {
  readonly brand: BrandProfile;
  /** One generation: the run home applied, then the SDK's `query()`. Refuses a call without a run home. */
  query(args: { prompt: string | AsyncIterable<string>; options?: HostQueryOptions }): Query;
  directory: RuntimeDirectory;
  messaging: GlobalMessagingHandle;
  /** The model-switch review over the shared store (`reviewSwitch`), and that store. */
  readonly reviewer: SwitchReviewerHandle;
  /** The object every seam was built from (directory, store home, brand) — for the host's own tests. */
  readonly context: SeamContextWithDirectory;
  /** `safe` once a run home's query has ended (dispose it then), `quarantined`, or `pending`. */
  runHomeOutcome(runId: string): RunHomeOutcome;
  /**
   * Reconciles a recorded local-write root a crash left behind, through the host's own store. Per
   * transcript: `clean`, `appended`, `canonical-ahead` or `quarantined` (copied under
   * `<home>/cache/quarantine/`). A host must let it finish before any session it recovers opens.
   */
  reconcileRootForRecovery(root: string): Promise<RecoveryReport>;
  dispose(): Promise<void>;
}

export function createRuntimeSdkHost(opts: RuntimeSdkHostOptions): RuntimeSdkHost {
  const sdk = opts.sdk ?? cloverSdk;
  const resolved = sdk.resolveBrand(opts.brand);
  if (!resolved.ok) throw new sdk.InvalidBrandError(resolved.reason);
  const brand = resolved.brand;
  const requireRunHome = opts.requireRunHome === true;
  const home = opts.home;
  if (requireRunHome && (home === undefined || home.length === 0)) {
    throw new RuntimeSdkError("a session host with `requireRunHome` roots its transcript store at the shared runtime home under the daemon's home, so the home must be named (WS-21 §3.1)");
  }
  const storeHome = requireRunHome && home !== undefined ? sdkHomeOf(home) : undefined;
  const directoryStore = opts.directoryStore ?? createInMemoryRuntimeDirectoryStore();
  const base: SeamContext = {
    sdk,
    brand,
    directoryStore,
    ...(home === undefined ? {} : { home }),
    ...(storeHome === undefined ? {} : { storeHome }),
  };
  const runHomeOutcomes = new Map<string, RunHomeOutcome>();
  // The directory and the messaging router come from ONE factory: the directory's child view delivers
  // through the router while the router resolves through the directory.
  const { directory, messaging } = createRuntimeMessaging(base, opts.messaging ?? {}, {
    winterRunHomes: {
      require: requireRunHome,
      ...(opts.runHomeFor === undefined ? {} : { runHomeFor: opts.runHomeFor }),
      apply: (options, runHome) => {
        assertRunHomeApplicable(runHome, { leg: "winter", cwd: options.cwd, brand, storeHome });
        return applyWinterRunHome(options, runHome, brand);
      },
      record: (runId, outcome) => {
        runHomeOutcomes.set(runId, outcome);
      },
    },
  });
  const context: SeamContextWithDirectory = { ...base, directory };
  // Absent, the reviewer reads `defaultEndpointResolver()` itself, when it first needs it.
  const reviewer = createSwitchReviewer(context, opts.resolveEndpoint === undefined ? {} : { resolveEndpoint: opts.resolveEndpoint });

  let disposed = false;
  const assertLive = (method: string): void => {
    if (disposed) throw new RuntimeSdkDisposedError(method);
  };

  return {
    brand,
    directory,
    messaging,
    reviewer,
    context,
    query(args) {
      assertLive("query");
      const options = args.options ?? {};
      const runHome = options.runtime?.runHome;
      if (requireRunHome && runHome === undefined) {
        throw new RunHomeError(
          "run_home_required",
          "this session host requires a run home, so every generation must carry the per-run folder the host built for it (`runtime.runHome`, from `buildRunHome`) — without one the session would read the user's real home (WS-21 §3.1)",
        );
      }
      if (runHome !== undefined) {
        assertRunHomeApplicable(runHome, { leg: "winter", cwd: options.cwd, brand, storeHome });
        // The options a run home decides are not the caller's (FIX ROUND 1, M1 of WS-21).
        assertNoRunHomeDecidedOptions(options);
      }
      // The run home's env, setting source and memory pin go on first (it refuses options that carry a
      // brand, which is the host's to fill), then `runtime` comes off and the host's brand fills in.
      // The caller's own object when there is nothing to apply, take off or fill in (the router's
      // pass-through property); otherwise a copy whose every other member is the caller's own value.
      const applied: HostQueryOptions = runHome === undefined ? options : applyWinterRunHome(options, runHome, brand);
      const fillBrand = opts.brand !== undefined && applied.brand === undefined;
      let forwarded: Options = applied;
      if ("runtime" in applied || fillBrand) {
        const { runtime: _runtime, ...callerOptions } = applied;
        forwarded = fillBrand ? { ...callerOptions, brand } : callerOptions;
      }
      const query = sdk.query({ prompt: args.prompt, options: forwarded });
      if (runHome === undefined) return query;
      // `pending` while the generation runs, `safe` only once it ENDS: the session reads the run folder
      // for as long as it runs, and a host disposes on `safe`.
      const runId = runHome.runId;
      runHomeOutcomes.set(runId, "pending");
      return observeQueryEnd(query, () => {
        runHomeOutcomes.set(runId, "safe");
      });
    },
    runHomeOutcome(runId) {
      return runHomeOutcomes.get(runId) ?? "pending";
    },
    async reconcileRootForRecovery(root) {
      assertLive("reconcileRootForRecovery");
      // The host's own store, and the daemon's home for the quarantine (spec §3.8). A host on the
      // pre-WS-21 layout has no shared runtime home to recover into, so it refuses rather than guess.
      if (storeHome === undefined || home === undefined) {
        throw new RuntimeSdkError("reconcileRootForRecovery needs a session host created with `requireRunHome` and a home — the recovered transcript belongs in the shared runtime home under it (WS-21 §3.8)");
      }
      return reconcileRootForRecovery(root, { shared: reviewer.shared, home, storeHome, resolveEndpoint: opts.resolveEndpoint ?? defaultEndpointResolver() });
    },
    async dispose() {
      // Idempotent: a host that disposes twice (a shutdown path and a signal handler) must not fail.
      disposed = true;
    },
  };
}
