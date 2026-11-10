// The `app` role's peer-image check (the caller check, spec §3.1): an `app` hello counts only from a process whose
// code signature is the Clover app's for this profile. The token alone isn't enough: any unfenced process of the
// user's can read `<home>/run/app.token`, and #418's known gap (an unfenced child that disclaims itself) passes the
// floor and the lineage checks. With this check such a process must also BE the signed app.
//
//   macOS    the peer's audit token (`LOCAL_PEERTOKEN`, `peer-handle.ts`), never a bare pid: the kernel names the
//            process by pid and pid version, so a pid reused since names nothing and the check fails. The code
//            object comes from `SecCodeCopyGuestWithAttributes` with `kSecGuestAttributeAudit`, and
//            `SecCodeCheckValidity` checks it DYNAMICALLY (the running process's own signing state) against
//              dist  identifier "com.waifucave.clover", Apple's chain, a Developer ID Application leaf, Clover's team
//                    (without the Developer ID clauses only when this daemon is not itself Developer ID signed: the
//                    owner's --sign-dev alpha, or a daemon run from a checkout)
//              dev   identifier "com.waifucave.clover.dev", Apple's chain and the team (`bun run dev:app` signs its
//                    Electron copy with the dev identity, `scripts/dev-app.ts`)
//            and then the signing information (`SecCodeCopySigningInformation`, dynamic): the hardened runtime in the
//            signature and in the running process, never get-task-allow or a debugged process, and none of the
//            entitlements that open it (`get-task-allow`, `allow-dyld-environment-variables`,
//            `disable-library-validation`). Unsigned, ad hoc, another team's, another identifier, unhardened, a token
//            the kernel didn't give, a process gone since: refused. The check is worth what the signed binary refuses to run: the hardened runtime keeps
//            out injected libraries and task ports, the packaged app's Electron fuses turn off ELECTRON_RUN_AS_NODE,
//            NODE_OPTIONS and the inspector and load only its integrity-checked app.asar (`electron-builder.yml`),
//            and the app must refuse Chromium's remote-debugging switches (lane E's, spec §3.1).
//   Linux    no check, and none is faked: the kernel keeps no code signature for a running process (IMA appraisal
//            is not something a desktop distribution turns on), and any process of the user's can start the app
//            under LD_PRELOAD or ptrace it. The fence (the floor) and the daemon's lineage stand alone there.
//   Windows  no check, and none is faked: Authenticode signs FILES, and a running process's image name can be made
//            to point at another file (a running .exe can be renamed and a signed one put in its place), while any
//            process of the user's can open the signed app with full access and write code into it (no hardened
//            runtime short of Microsoft's protected processes). A check there would pass the very process it is
//            meant to stop. The fence (AppContainer and the daemon's job) stands alone there.
//
// Never throws: any failure (a symbol missing, a non-zero OSStatus) is "not the app".
import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import { appRequirement, CLOVER_TEAM_ID, DEVELOPER_ID_CLAUSES } from "../bundled-identities";
import type { CloverProfile } from "../profile";
import type { PeerFacts } from "./caller-probe";
import type { DaemonPlatform } from "./transport";

/** Whether the peer of an `app` hello is the Clover app. Injected in tests. */
export type AppPeerCheck = (peer: PeerFacts) => boolean;
/** The caller check's `app` image check: a check, or `"none"` where the OS has none to make (named, never omitted). */
export type AppPeerPolicy = AppPeerCheck | "none";

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
/** `RTLD_DEFAULT` on Darwin: `((void *) -2)`. */
const RTLD_DEFAULT = -2n;
/** The audit token's size (`audit_token_t`, eight 32-bit words). */
const AUDIT_TOKEN_BYTES = 32;

type Ref = bigint;

/** `SecCSFlags` for `SecCodeCopySigningInformation`: the signing facts and the running process's status. */
const K_SEC_CS_SIGNING_INFORMATION = 1 << 1;
const K_SEC_CS_DYNAMIC_INFORMATION = 1 << 3;
/** The signature's hardened-runtime flag (`kSecCodeSignatureRuntime`) and the kernel's (`CS_RUNTIME`). */
const RUNTIME = 0x10000;
/** `CS_GET_TASK_ALLOW` and `CS_DEBUGGED` in the process's code-signing status. */
const CS_GET_TASK_ALLOW = 0x4;
const CS_DEBUGGED = 0x10000000;
const K_CF_NUMBER_SINT64_TYPE = 4;
/** Entitlements that let another process into a hardened one, or load code its signature doesn't cover. */
export const OPENING_ENTITLEMENTS = [
  "com.apple.security.get-task-allow",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-library-validation",
] as const;

function loadLibs() {
  const REF = FFIType.u64;
  const cf = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithCString: { args: [REF, FFIType.ptr, FFIType.u32], returns: REF },
    CFDataCreate: { args: [REF, FFIType.ptr, FFIType.i64], returns: REF },
    CFDictionaryCreate: { args: [REF, FFIType.ptr, FFIType.ptr, FFIType.i64, REF, REF], returns: REF },
    CFDictionaryGetValue: { args: [REF, REF], returns: REF },
    CFDictionaryGetTypeID: { args: [], returns: FFIType.u64 },
    CFNumberGetTypeID: { args: [], returns: FFIType.u64 },
    CFGetTypeID: { args: [REF], returns: FFIType.u64 },
    CFNumberGetValue: { args: [REF, FFIType.i64, FFIType.ptr], returns: FFIType.u8 },
    CFRelease: { args: [REF], returns: FFIType.void },
  });
  const sec = dlopen(SECURITY, {
    SecCodeCopyGuestWithAttributes: { args: [REF, REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecCodeCopySelf: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecRequirementCreateWithString: { args: [REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecCodeCheckValidity: { args: [REF, FFIType.u32, REF], returns: FFIType.i32 },
    SecCodeCopySigningInformation: { args: [REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const sys = dlopen(LIBSYSTEM, {
    dlsym: { args: [FFIType.i64, FFIType.ptr], returns: REF },
  });
  return { cf: cf.symbols, sec: sec.symbols, sys: sys.symbols };
}

let libs: ReturnType<typeof loadLibs> | undefined;
const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8");

/** A CFString constant the Security framework exports as data (`kSecCodeInfoFlags` and the like): dlsym gives the
 *  variable's address, which holds the CFStringRef. 0n when missing. */
function dataSymbol(name: string): Ref {
  const { sys } = libs!;
  const at = BigInt(sys.dlsym(RTLD_DEFAULT, cstr(name)));
  return at === 0n ? 0n : BigInt(read.u64(Number(at) as Pointer, 0));
}

/** A signed 64-bit CFNumber's value, or null. */
function numberOf(ref: Ref): number | null {
  const { cf } = libs!;
  if (ref === 0n || BigInt(cf.CFGetTypeID(ref)) !== BigInt(cf.CFNumberGetTypeID())) return null;
  const out = new BigInt64Array(1);
  return cf.CFNumberGetValue(ref, K_CF_NUMBER_SINT64_TYPE, out) ? Number(out[0]!) : null;
}

/**
 * The running `code`'s signature is hardened and nothing opens it: the runtime flag in its signature and in the
 * kernel's status, no get-task-allow and no debugging in that status, none of `OPENING_ENTITLEMENTS`. Every key the
 * answer lacks is a refusal.
 */
function hardenedAndClosed(code: Ref, owned: Ref[]): boolean {
  const { cf, sec } = libs!;
  const infoOut = new BigUint64Array(1);
  if (sec.SecCodeCopySigningInformation(code, K_SEC_CS_SIGNING_INFORMATION | K_SEC_CS_DYNAMIC_INFORMATION, infoOut) !== 0 || infoOut[0] === 0n) return false;
  const info = infoOut[0]!;
  owned.push(info);
  const flagsKey = dataSymbol("kSecCodeInfoFlags"), statusKey = dataSymbol("kSecCodeInfoStatus"), entKey = dataSymbol("kSecCodeInfoEntitlementsDict");
  if (flagsKey === 0n || statusKey === 0n || entKey === 0n) return false;
  const flags = numberOf(BigInt(cf.CFDictionaryGetValue(info, flagsKey)));
  const status = numberOf(BigInt(cf.CFDictionaryGetValue(info, statusKey)));
  if (flags === null || status === null) return false;
  if ((flags & RUNTIME) === 0 || (status & RUNTIME) === 0) return false;
  if ((status & CS_GET_TASK_ALLOW) !== 0 || (status & CS_DEBUGGED) !== 0) return false;
  const entitlements = BigInt(cf.CFDictionaryGetValue(info, entKey));
  if (entitlements === 0n) return true; // no entitlements at all
  if (BigInt(cf.CFGetTypeID(entitlements)) !== BigInt(cf.CFDictionaryGetTypeID())) return false;
  for (const name of OPENING_ENTITLEMENTS) {
    const key = BigInt(cf.CFStringCreateWithCString(0n, cstr(name), K_CF_STRING_ENCODING_UTF8));
    if (key === 0n) return false;
    owned.push(key);
    if (BigInt(cf.CFDictionaryGetValue(entitlements, key)) !== 0n) return false;
  }
  return true;
}

/** Checks `code` against `requirement` (dynamically), then, unless `hardened` is false, `hardenedAndClosed`. */
function codeSatisfies(code: Ref, requirement: string, hardened: boolean, owned: Ref[]): boolean {
  const { cf, sec } = libs!;
  const reqText = BigInt(cf.CFStringCreateWithCString(0n, cstr(requirement), K_CF_STRING_ENCODING_UTF8));
  if (reqText === 0n) return false;
  owned.push(reqText);
  const reqOut = new BigUint64Array(1);
  if (sec.SecRequirementCreateWithString(reqText, 0, reqOut) !== 0 || reqOut[0] === 0n) return false;
  owned.push(reqOut[0]!);
  if (sec.SecCodeCheckValidity(code, 0, reqOut[0]!) !== 0) return false;
  return !hardened || hardenedAndClosed(code, owned);
}

/**
 * Does the RUNNING process the audit `token` names satisfy `requirement`, hardened and closed (`hardened: false`
 * checks the requirement alone)? The kernel resolves the token by pid AND pid version, so a process that has exited
 * (its pid perhaps reused) fails. `false` on any failure.
 */
export function auditTokenSatisfies(token: Uint8Array | undefined, requirement: string, o: { hardened?: boolean } = {}): boolean {
  if (process.platform !== "darwin" || token === undefined || token.byteLength !== AUDIT_TOKEN_BYTES) return false;
  const owned: Ref[] = [];
  try {
    libs ??= loadLibs();
    const { cf, sec, sys } = libs;
    const keyCallBacks = BigInt(sys.dlsym(RTLD_DEFAULT, cstr("kCFTypeDictionaryKeyCallBacks")));
    const valueCallBacks = BigInt(sys.dlsym(RTLD_DEFAULT, cstr("kCFTypeDictionaryValueCallBacks")));
    if (keyCallBacks === 0n || valueCallBacks === 0n) return false;

    // `kSecGuestAttributeAudit` (the CFString "audit"), its value the token's bytes as CFData.
    const key = dataSymbol("kSecGuestAttributeAudit");
    if (key === 0n) return false;
    const bytes = Buffer.from(token);
    const data = BigInt(cf.CFDataCreate(0n, ptr(bytes), AUDIT_TOKEN_BYTES));
    if (data === 0n) return false;
    owned.push(data);
    const keys = new BigUint64Array([key]);
    const values = new BigUint64Array([data]);
    const attributes = BigInt(cf.CFDictionaryCreate(0n, keys, values, 1, keyCallBacks, valueCallBacks));
    if (attributes === 0n) return false;
    owned.push(attributes);

    const codeOut = new BigUint64Array(1);
    if (sec.SecCodeCopyGuestWithAttributes(0n, attributes, 0, codeOut) !== 0 || codeOut[0] === 0n) return false;
    owned.push(codeOut[0]!);
    return codeSatisfies(codeOut[0]!, requirement, o.hardened !== false, owned);
  } catch {
    return false;
  } finally {
    for (const ref of owned) { try { libs?.cf.CFRelease(ref); } catch { /* best effort */ } }
  }
}

/** Whether THIS process satisfies `requirement` (the requirement alone). False off macOS and on any failure. */
export function selfSatisfies(requirement: string): boolean {
  if (process.platform !== "darwin") return false;
  const owned: Ref[] = [];
  try {
    libs ??= loadLibs();
    const codeOut = new BigUint64Array(1);
    if (libs.sec.SecCodeCopySelf(0, codeOut) !== 0 || codeOut[0] === 0n) return false;
    owned.push(codeOut[0]!);
    return codeSatisfies(codeOut[0]!, requirement, false, owned);
  } catch {
    return false;
  } finally {
    for (const ref of owned) { try { libs?.cf.CFRelease(ref); } catch { /* best effort */ } }
  }
}

/** The check for an `app` peer against `requirement`, through the connection's audit token only, hardened and
 *  closed: a peer probed without a token (no handle, or a handle that isn't a token) is refused. */
export function appPeerByRequirement(requirement: string): AppPeerCheck {
  return (peer) => peer.handle?.via === "token" && auditTokenSatisfies(peer.handle.auditToken, requirement);
}

/** The requirement this daemon holds an `app` peer to on macOS: `appRequirement(profile)`, whose dist form names a
 *  Developer ID leaf unless this daemon itself has none (`selfDeveloperId`: the owner's dev-signed alpha, a daemon
 *  run from a checkout), which would otherwise refuse its own app. */
export function appPeerRequirement(profile: CloverProfile, selfDeveloperId: () => boolean = () => selfSatisfies(appRequirementSelf())): string {
  return profile === "dist" ? appRequirement("dist", undefined, selfDeveloperId()) : appRequirement("dev");
}

/** Any Developer ID Application signature of Clover's team (the daemon's own, whatever its identifier). */
function appRequirementSelf(): string {
  return `anchor apple generic and ${DEVELOPER_ID_CLAUSES} and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`;
}

/** The daemon's `app` peer check on `os` for `profile`: macOS checks the signature; Linux and Windows have none to
 *  make (`"none"`; see the head of this file). */
export function defaultAppPeerCheck(os: DaemonPlatform, profile: CloverProfile): AppPeerPolicy {
  return os === "darwin" ? appPeerByRequirement(appPeerRequirement(profile)) : "none";
}
