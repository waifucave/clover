// The `app` role's peer-image check (the caller check, spec §3.1): an `app` hello counts only from a process whose
// code signature is the Clover app's for this profile. The token alone isn't enough: any unfenced process of the
// user's can read `<home>/run/app.token`, and #418's known gap (an unfenced child that disclaims itself) passes the
// floor and the lineage checks. With this check such a process must also BE the signed app.
//
//   macOS    the peer's audit token (`LOCAL_PEERTOKEN`, `peer-handle.ts`), never a bare pid: the kernel names the
//            process by pid and pid version, so a pid reused since names nothing and the check fails. The code
//            object comes from `SecCodeCopyGuestWithAttributes` with `kSecGuestAttributeAudit`, and
//            `SecCodeCheckValidity` checks it DYNAMICALLY (the running process's own signing state) against
//              dist  identifier "com.waifucave.clover" and anchor apple generic and leaf[subject.OU] = Clover's team
//              dev   identifier "com.waifucave.clover.dev", the same team (`bun run dev:app` signs its Electron copy
//                    with the dev identity, `scripts/dev-app.ts`)
//            Unsigned, ad hoc, another team's, another identifier, a token the kernel didn't give, a process gone
//            since: refused. The check is worth what the signed binary refuses to run: the hardened runtime keeps
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
import { dlopen, FFIType, ptr } from "bun:ffi";
import { appRequirement } from "../bundled-identities";
import type { CloverProfile } from "../profile";
import type { PeerFacts } from "./caller-probe";
import type { DaemonPlatform } from "./transport";

/** Whether the peer of an `app` hello is the Clover app. Injected in tests. */
export type AppPeerCheck = (peer: PeerFacts) => boolean;

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
/** `RTLD_DEFAULT` on Darwin: `((void *) -2)`. */
const RTLD_DEFAULT = -2n;
/** The audit token's size (`audit_token_t`, eight 32-bit words). */
const AUDIT_TOKEN_BYTES = 32;

type Ref = bigint;

function loadLibs() {
  const REF = FFIType.u64;
  const cf = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithCString: { args: [REF, FFIType.ptr, FFIType.u32], returns: REF },
    CFDataCreate: { args: [REF, FFIType.ptr, FFIType.i64], returns: REF },
    CFDictionaryCreate: { args: [REF, FFIType.ptr, FFIType.ptr, FFIType.i64, REF, REF], returns: REF },
    CFRelease: { args: [REF], returns: FFIType.void },
  });
  const sec = dlopen(SECURITY, {
    SecCodeCopyGuestWithAttributes: { args: [REF, REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecRequirementCreateWithString: { args: [REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecCodeCheckValidity: { args: [REF, FFIType.u32, REF], returns: FFIType.i32 },
  });
  const sys = dlopen(LIBSYSTEM, {
    dlsym: { args: [FFIType.i64, FFIType.ptr], returns: REF },
  });
  return { cf: cf.symbols, sec: sec.symbols, sys: sys.symbols };
}

let libs: ReturnType<typeof loadLibs> | undefined;
const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8");

/**
 * Does the RUNNING process the audit `token` names satisfy `requirement`? The kernel resolves the token by pid AND
 * pid version, so a process that has exited (its pid perhaps reused) fails. `false` on any failure.
 */
export function auditTokenSatisfies(token: Uint8Array | undefined, requirement: string): boolean {
  if (process.platform !== "darwin" || token === undefined || token.byteLength !== AUDIT_TOKEN_BYTES) return false;
  const owned: Ref[] = [];
  try {
    libs ??= loadLibs();
    const { cf, sec, sys } = libs;
    const keyCallBacks = BigInt(sys.dlsym(RTLD_DEFAULT, cstr("kCFTypeDictionaryKeyCallBacks")));
    const valueCallBacks = BigInt(sys.dlsym(RTLD_DEFAULT, cstr("kCFTypeDictionaryValueCallBacks")));
    if (keyCallBacks === 0n || valueCallBacks === 0n) return false;

    // `kSecGuestAttributeAudit` is the CFString "audit" (a data symbol, which dlopen can't hand over; dictionary keys
    // compare with CFEqual), its value the token's bytes as CFData.
    const key = BigInt(cf.CFStringCreateWithCString(0n, cstr("audit"), K_CF_STRING_ENCODING_UTF8));
    if (key === 0n) return false;
    owned.push(key);
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

    const reqText = BigInt(cf.CFStringCreateWithCString(0n, cstr(requirement), K_CF_STRING_ENCODING_UTF8));
    if (reqText === 0n) return false;
    owned.push(reqText);
    const reqOut = new BigUint64Array(1);
    if (sec.SecRequirementCreateWithString(reqText, 0, reqOut) !== 0 || reqOut[0] === 0n) return false;
    owned.push(reqOut[0]!);

    return sec.SecCodeCheckValidity(codeOut[0]!, 0, reqOut[0]!) === 0;
  } catch {
    return false;
  } finally {
    for (const ref of owned) { try { libs?.cf.CFRelease(ref); } catch { /* best effort */ } }
  }
}

/** The check for an `app` peer against `requirement`, through the connection's audit token only: a peer probed
 *  without one (no handle, or a handle that isn't a token) is refused. */
export function appPeerByRequirement(requirement: string): AppPeerCheck {
  return (peer) => peer.handle?.via === "token" && auditTokenSatisfies(peer.handle.auditToken, requirement);
}

/** The daemon's `app` peer check on `os` for `profile`: macOS checks the signature; Linux and Windows have none to
 *  make (null; see the head of this file). */
export function defaultAppPeerCheck(os: DaemonPlatform, profile: CloverProfile): AppPeerCheck | null {
  return os === "darwin" ? appPeerByRequirement(appRequirement(profile)) : null;
}
