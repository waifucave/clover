// A small bun:ffi loader shared by the platform probes: a library opened once, with symbol types
// given as names, and `null` where the library or bun:ffi isn't there (every caller fails closed).
type Fn = (...args: unknown[]) => unknown;
export type FfiLib = Record<string, Fn>;
const libs = new Map<string, FfiLib | null>();

export function ffiLib(key: string, path: string, symbols: Record<string, { args: string[]; returns: string }>): FfiLib | null {
  if (libs.has(key)) return libs.get(key)!;
  let lib: FfiLib | null = null;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const defs = Object.fromEntries(Object.entries(symbols).map(([name, s]) => [name, {
      args: s.args.map((a) => FFIType[a as keyof typeof FFIType]),
      returns: FFIType[s.returns as keyof typeof FFIType],
    }]));
    lib = dlopen(path, defs as never).symbols as unknown as FfiLib;
  } catch { lib = null; }
  libs.set(key, lib);
  return lib;
}

export const ffiPtr = (b: ArrayBufferView): unknown => (require("bun:ffi") as typeof import("bun:ffi")).ptr(b as never);

/** A UTF-16 string at a native pointer, `chars` long. */
export function ffiWide(p: number | bigint, chars: number): string {
  const { toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
  return Buffer.from(toArrayBuffer(Number(p) as never, 0, chars * 2)).toString("utf16le");
}
