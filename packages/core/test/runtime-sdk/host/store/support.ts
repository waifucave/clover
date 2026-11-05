// Lane C's bed: a throwaway Winter home, the real concrete store, and the spine's own seam context.
//
// HERMETIC BY CONSTRUCTION. Every home is an `mkdtemp` directory removed in a `finally`; the temp
// layout is driven by an INJECTED env rather than `process.env`; nothing reads a real daemon home, `~/.claude`
// or the Keychain, and no test in this directory starts a network listener.
//
// THE CONTEXT IS THE REAL ONE. `createRuntimeSdkHost` builds exactly one `SeamContextWithDirectory` and
// hands it to every seam factory; its `context` member reaches it. Building a hand-rolled context here
// would test the shape this lane's factories were written against rather than the one they will be
// handed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { WINTER_BRAND, WinterCompatibilitySessionStore, type SessionKey, type SessionStoreEntry } from "@waifucave/clover-agent-sdk";

import { createRuntimeSdkHost, type HostSdk } from "../../../../src/runtime-sdk/host/index";
import type { SeamContextWithDirectory } from "../../../../src/runtime-sdk/host/seams/context";
import { createInMemoryRuntimeDirectoryStore, type RuntimeDirectoryEntry, type RuntimeDirectoryStore } from "../../../../src/runtime-sdk/host/seams/directory-store";
import type { RuntimeKind, RuntimeSelection } from "../../../../src/runtime-sdk/host/selection/runtime-selection";
import { createFakeKeychain, createFakeWinterPeer } from "../testing/index";
import { createSharedSessionStore, type MirrorPolicy, type SharedSessionStore } from "../../../../src/runtime-sdk/host/store/index";

/**
 * A fake SDK that also carries the concrete store.
 *
 * The fake exports the members `createRuntimeSdkHost` touches; Lane C's factories read
 * `WinterCompatibilitySessionStore` and `resolveWinterHome` off the SDK as well, because WS-05 §6's
 * "the identical package/version" is a statement about the instance the host was handed. Spreading the
 * REAL class onto the fake is what keeps that true in a test.
 */
export function storeSdk(overrides: Partial<{ store: unknown }> = {}): HostSdk {
  const { peer } = createFakeWinterPeer();
  return {
    ...peer,
    WinterCompatibilitySessionStore: overrides.store ?? WinterCompatibilitySessionStore,
    resolveWinterHome: () => {
      throw new Error("a hermetic test must never resolve the real Winter home");
    },
  } as unknown as HostSdk;
}

export interface StoreBed {
  home: string;
  /** A temp root for D18's layout, injected as `<PREFIX>TMPDIR` rather than exported. */
  tempBase: string;
  sdk: HostSdk;
  shared: SharedSessionStore;
  context: SeamContextWithDirectory;
  directoryStore: RuntimeDirectoryStore;
  key: SessionKey;
  /** A chain-valid dialect entry whose parent is the previous one this bed produced. */
  entry(overrides?: Partial<SessionStoreEntry> & { key?: SessionKey }): SessionStoreEntry;
  /** Appends `count` chained entries through the shared store and settles. */
  append(count: number, key?: SessionKey): Promise<SessionStoreEntry[]>;
  /** Records a directory entry for `key`, as the launch would. */
  record(overrides?: Partial<RuntimeDirectoryEntry>): Promise<RuntimeDirectoryEntry>;
}

export interface StoreBedOptions {
  policy?: Partial<MirrorPolicy>;
  /** Swaps the store class on the injected peer — the seam a failure-injection test uses. */
  store?: unknown;
  directoryStore?: RuntimeDirectoryStore;
}

export async function withStoreBed<T>(fn: (bed: StoreBed) => Promise<T>, options: StoreBedOptions = {}): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "runtime-sdk-lane-c-"));
  try {
    const home = join(root, "home");
    const tempBase = join(root, "temp");
    const sdk = storeSdk(options.store === undefined ? {} : { store: options.store });
    const directoryStore = options.directoryStore ?? createInMemoryRuntimeDirectoryStore();
    const host = createRuntimeSdkHost({ brand: WINTER_BRAND, sdk, directoryStore });
    const context = host.context;
    const shared = createSharedSessionStore({ sdk, winterHome: home, ...(options.policy === undefined ? {} : { policy: options.policy }) });
    const key: SessionKey = { projectKey: "-lane-c-project", sessionId: "11111111-2222-4333-8444-555555555555" };

    let parent: string | null = null;
    const bed: StoreBed = {
      home,
      tempBase,
      sdk,
      shared,
      context,
      directoryStore,
      key,
      entry(overrides = {}) {
        const { key: entryKey, ...rest } = overrides;
        const uuid = (rest["uuid"] as string | undefined) ?? randomUUID();
        const built: SessionStoreEntry = {
          type: "user",
          uuid,
          parentUuid: parent,
          sessionId: (entryKey ?? key).sessionId,
          timestamp: new Date().toISOString(),
          cwd: "/lane-c",
          version: "0.0.0",
          isSidechain: false,
          message: { role: "user", content: "hello" },
          ...rest,
        };
        parent = uuid;
        return built;
      },
      async append(count, target = key) {
        const entries: SessionStoreEntry[] = [];
        for (let i = 0; i < count; i++) entries.push(bed.entry({ key: target }));
        await shared.store.append(target, entries);
        await shared.settle(target);
        return entries;
      },
      async record(overrides = {}) {
        const entry: RuntimeDirectoryEntry = {
          address: `session:s_${key.sessionId.slice(0, 8)}`,
          parsed: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: `s_${key.sessionId.slice(0, 8)}`, backendSessionId: key.sessionId },
          runtimeKind: "winter-agent",
          objectKind: "session",
          transport: "winter-session",
          status: "idle",
          mode: "code",
          generation: 1,
          selection: selectionFor("winter-agent"),
          backendSessionId: key.sessionId,
          capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
          updatedAt: new Date().toISOString(),
          ...overrides,
        };
        await directoryStore.upsert(entry);
        return entry;
      },
    };
    return await fn(bed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A `RuntimeSelection` shaped exactly as Lane D's selector produces one. */
export function selectionFor(runtimeKind: RuntimeKind): RuntimeSelection {
  return {
    runtimeKind,
    providerId: runtimeKind === "claude-agent" ? "anthropic" : "local",
    modelRef: "test-model",
    family: runtimeKind === "claude-agent" ? "claude" : "astra",
    authFamily: runtimeKind === "claude-agent" ? "api-key" : "local-none",
    sdkVersion: "0.0.2",
    engineVersion: "0.0.2",
    reason: "lane-c test fixture",
    decidedAt: new Date(0).toISOString(),
  };
}

/** The provider-state sidecar's path under a home — named so a test can assert it is NEVER touched. */
export function sidecarPathFor(home: string, key: SessionKey): string {
  return join(home, "projects", key.projectKey, `${key.sessionId}.provider-state.jsonl`);
}
