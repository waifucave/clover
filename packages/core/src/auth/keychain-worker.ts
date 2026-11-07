// The pinned keychain's item calls (find/read, write, delete) on a worker thread of their own (#243 check 4).
// `Bun.secrets` ran its calls off the JS thread; keychain-ffi's are synchronous, so a consent prompt (an item whose
// access list doesn't trust this binary) would stall the daemon's event loop until someone answered it. Here the
// main thread only OPENS the keychain (login-keychain.ts: no item, no prompt) and hands its reference to one worker,
// which makes the Security calls and answers by message. The keychain reference is a process-wide CF object, valid
// on any thread; the worker never releases it.
//
// The worker is a Blob made from `keychainWorkerMain`'s source, so it needs no entry point of its own in the
// compiled core (the same way `__fetch-probe --worker` runs); that function therefore uses only its parameters.
// Errors cross as (operation, status) and are thrown here as `KeychainFfiError`, never with a value in them.
import { KeychainFfiError, type KeychainFile } from "./keychain-ffi";

type Op = "get" | "set" | "delete";
interface Reply { id: number; ok: boolean; result?: string | null | boolean; operation?: string; status?: number }

/** Runs in the worker. Self-contained: only its parameters and the worker's globals. */
function keychainWorkerMain(ffi: typeof import("bun:ffi")): void {
  const { dlopen, FFIType, ptr, toArrayBuffer } = ffi;
  const REF = FFIType.u64;
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", { CFRelease: { args: [REF], returns: FFIType.void } }).symbols;
  const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecKeychainFindGenericPassword: { args: [REF, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemFreeContent: { args: [REF, REF], returns: FFIType.i32 },
    SecKeychainItemDelete: { args: [REF], returns: FFIType.i32 },
    SecKeychainAddGenericPassword: { args: [REF, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemModifyAttributesAndData: { args: [REF, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const NOT_FOUND = -25300;
  class Failed { constructor(readonly operation: string, readonly status: number) {} }
  const find = (kc: bigint, service: string, account: string, withData: boolean) => {
    const svc = Buffer.from(service, "utf8"), acct = Buffer.from(account, "utf8");
    const itemOut = new BigUint64Array(1), lenOut = new Uint32Array(1), dataOut = new BigUint64Array(1);
    const status = sec.SecKeychainFindGenericPassword(kc, svc.length, ptr(svc), acct.length, ptr(acct), withData ? ptr(lenOut) : null, withData ? ptr(dataOut) : null, ptr(itemOut));
    void [svc, acct].length;
    if (status !== 0) return { status, item: 0n, value: null as string | null };
    let value: string | null = null;
    if (withData) {
      const data = dataOut[0]!, length = lenOut[0]!;
      value = length === 0 || data === 0n ? "" : Buffer.from(toArrayBuffer(Number(data) as never, 0, length)).toString("utf8");
      if (data !== 0n) sec.SecKeychainItemFreeContent(0n, data);
    }
    return { status, item: itemOut[0]!, value };
  };
  const remove = (kc: bigint, service: string, account: string): boolean => {
    const found = find(kc, service, account, false);
    if (found.status === NOT_FOUND) return false;
    if (found.status !== 0) throw new Failed("find", found.status);
    try {
      const status = sec.SecKeychainItemDelete(found.item);
      if (status !== 0) throw new Failed("delete", status);
      return true;
    } finally {
      cf.CFRelease(found.item);
    }
  };
  const run = (op: string, kc: bigint, service: string, account: string, value: string | undefined): string | null | boolean | undefined => {
    if (op === "get") {
      const found = find(kc, service, account, true);
      if (found.status === NOT_FOUND) return null;
      if (found.status !== 0) throw new Failed("read", found.status);
      cf.CFRelease(found.item);
      return found.value;
    }
    if (op === "delete") return remove(kc, service, account);
    // set: an empty value deletes (`Bun.secrets.set`'s rule); an existing item's data is replaced in place (its
    // access list kept); a missing one is created with the default access and the service as its label.
    if (value === undefined || value === "") { remove(kc, service, account); return undefined; }
    const data = Buffer.from(value, "utf8");
    const found = find(kc, service, account, false);
    if (found.status === 0) {
      try {
        const status = sec.SecKeychainItemModifyAttributesAndData(found.item, null, data.length, ptr(data));
        if (status !== 0) throw new Failed("update", status);
      } finally {
        cf.CFRelease(found.item);
      }
      return undefined;
    }
    if (found.status !== NOT_FOUND) throw new Failed("find", found.status);
    const svc = Buffer.from(service, "utf8"), acct = Buffer.from(account, "utf8"), itemOut = new BigUint64Array(1);
    const status = sec.SecKeychainAddGenericPassword(kc, svc.length, ptr(svc), acct.length, ptr(acct), data.length, ptr(data), ptr(itemOut));
    void [svc, acct, data].length;
    if (status !== 0) throw new Failed("create", status);
    cf.CFRelease(itemOut[0]!);
    return undefined;
  };
  const scope = globalThis as unknown as { onmessage: (e: MessageEvent) => void; postMessage: (m: unknown) => void };
  scope.onmessage = (e: MessageEvent) => {
    const { id, op, ref, service, name, value } = e.data as { id: number; op: string; ref: string; service: string; name: string; value?: string };
    try {
      scope.postMessage({ id, ok: true, result: run(op, BigInt(ref), service, name, value) });
    } catch (err) {
      const f = err instanceof Failed ? err : new Failed(op, -1);
      scope.postMessage({ id, ok: false, operation: f.operation, status: f.status });
    }
  };
}

/** Bun's Worker keeps the process alive only while `ref`'d (its typings don't show `ref`/`unref`). */
type BunWorker = Worker & { ref(): void; unref(): void };
let worker: BunWorker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; account: string }>();

function keychainWorker(): BunWorker {
  if (worker !== undefined) return worker;
  const source = `import * as ffi from "bun:ffi";\n(${keychainWorkerMain.toString()})(ffi);\n`;
  const w = new Worker(URL.createObjectURL(new Blob([source], { type: "application/javascript" }))) as BunWorker;
  w.onmessage = (e: MessageEvent) => {
    const reply = e.data as Reply;
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.result);
    else waiting.reject(new KeychainFfiError(reply.operation ?? "keychain", reply.status ?? -1, waiting.account));
    if (pending.size === 0) w.unref();
  };
  w.onerror = (e) => {
    // A worker that failed takes its calls with it; the next call starts a fresh one.
    for (const [, waiting] of pending) waiting.reject(new KeychainFfiError(`keychain worker (${e.message})`, -1, waiting.account));
    pending.clear();
    if (worker === w) worker = undefined;
    w.terminate();
  };
  w.unref();
  worker = w;
  return w;
}

function call(keychain: () => KeychainFile, op: Op, service: string, name: string, value?: string): Promise<unknown> {
  // The keychain is opened (or refused, under a test) here, on the calling thread: no item is touched yet.
  const ref = keychain().ref;
  const w = keychainWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, account: name });
    w.ref();
    w.postMessage({ id, op, ref: ref.toString(), service, name, ...(value === undefined ? {} : { value }) });
  });
}

/** `Bun.secrets`' get/set/delete on `keychain`, each call made on the keychain worker thread. */
export function keychainWorkerBackend(keychain: () => KeychainFile): Pick<typeof Bun.secrets, "get" | "set" | "delete"> {
  return {
    get: async ({ service, name }) => (await call(keychain, "get", service, name)) as string | null,
    set: async ({ service, name, value }) => { await call(keychain, "set", service, name, value); },
    delete: async ({ service, name }) => (await call(keychain, "delete", service, name)) as boolean,
  };
}
