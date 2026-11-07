import { describe, expect, test } from "bun:test";
import { moduleGraphRange, REQUIRED_NATIVE_NAMES, SEALED_ENV_NAMES, sealBunDoors, sealedReplacement, sealFiller, sealProblems } from "./seal-bun-doors";

const enc = new TextEncoder();
/** Bun's native code as it names the doors: NUL-terminated, and in a run of names with no separators. */
const NATIVE = `\0NO_COLOR\0BUN_BE_BUN\0BUN_INSTRUMENTS\0link binaryBUN_OPTIONSBUN_INSPECTBUN_INSPECT_CONNECT_TOBUN_INSPECT_NOTIFYBUN_INSPECT_PRELOADNODE_CHANNEL_FD\0nodePath = Bun.env.NODE_PATH, x\0 if (process.env.BUN_INSPECT_NOTIFY = "", y) ["HOME",\n "NODE_PATH",\n "X"]\0`;
/** The app's own bundle, which names some of them on purpose (the run home's environment refusals). */
const GRAPH = `const refused = ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_INSPECT", "BUN_BE_BUN"];`;

function count(bytes: Uint8Array, s: string): number {
  const text = Buffer.from(bytes).toString("latin1");
  return text.split(s).length - 1;
}

/** A Mach-O with the native strings in one place and the module graph in `__BUN,__bun`. */
function macho(native: string, graph: string): Uint8Array {
  const n = enc.encode(native), g = enc.encode(graph);
  const lc = 72 + 80;
  const nativeAt = 32 + lc, graphAt = nativeAt + n.length;
  const b = new Uint8Array(graphAt + g.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xfeedfacf, true);
  v.setUint32(16, 1, true);
  v.setUint32(20, lc, true);
  v.setUint32(32, 0x19, true);
  v.setUint32(36, lc, true);
  b.set(enc.encode("__BUN"), 40);
  v.setUint32(32 + 64, 1, true);
  const sect = 32 + 72;
  b.set(enc.encode("__bun"), sect);
  b.set(enc.encode("__BUN"), sect + 16);
  v.setBigUint64(sect + 40, BigInt(g.length), true);
  v.setUint32(sect + 48, graphAt, true);
  b.set(n, nativeAt);
  b.set(g, graphAt);
  return b;
}

/** An ELF64 with `.rodata` (the natives) and `.bun` (the graph), and its section-name table. */
function elf(native: string, graph: string): Uint8Array {
  const n = enc.encode(native), g = enc.encode(graph), names = enc.encode("\0.rodata\0.bun\0.shstrtab\0");
  const nativeAt = 64, graphAt = nativeAt + n.length, namesAt = graphAt + g.length, shoff = namesAt + names.length;
  const b = new Uint8Array(shoff + 4 * 64);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x7f454c46, false);
  v.setBigUint64(0x28, BigInt(shoff), true);
  v.setUint16(0x3a, 64, true);
  v.setUint16(0x3c, 4, true);
  v.setUint16(0x3e, 3, true);
  const section = (i: number, nameOff: number, offset: number, size: number) => {
    v.setUint32(shoff + i * 64, nameOff, true);
    v.setBigUint64(shoff + i * 64 + 0x18, BigInt(offset), true);
    v.setBigUint64(shoff + i * 64 + 0x20, BigInt(size), true);
  };
  section(1, 1, nativeAt, n.length);
  section(2, 9, graphAt, g.length);
  section(3, 14, namesAt, names.length);
  b.set(n, nativeAt);
  b.set(g, graphAt);
  b.set(names, namesAt);
  return b;
}

/** A PE with `.rdata` (the natives) and `.bun` (the graph). */
function pe(native: string, graph: string): Uint8Array {
  const n = enc.encode(native), g = enc.encode(graph);
  const peAt = 0x40, opt = 0xf0, secs = peAt + 24 + opt, nativeAt = secs + 2 * 40, graphAt = nativeAt + n.length;
  const b = new Uint8Array(graphAt + g.length);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0x5a4d, true);
  v.setUint32(0x3c, peAt, true);
  v.setUint16(peAt + 6, 2, true);
  v.setUint16(peAt + 20, opt, true);
  const section = (i: number, name: string, offset: number, size: number) => {
    b.set(enc.encode(name), secs + i * 40);
    v.setUint32(secs + i * 40 + 16, size, true);
    v.setUint32(secs + i * 40 + 20, offset, true);
  };
  section(0, ".rdata", nativeAt, n.length);
  section(1, ".bun", graphAt, g.length);
  b.set(n, nativeAt);
  b.set(g, graphAt);
  return b;
}

describe("the replacements: same length, and a name no environment can carry", () => {
  test("native: a NUL, then capital letters (an empty C string, and a slice no key can equal)", () => {
    for (const name of SEALED_ENV_NAMES) {
      const r = sealedReplacement(name, "native");
      expect(r.offset).toBe(0);
      expect(r.bytes.length).toBe(name.length);
      expect(r.bytes[0]).toBe(0);
      expect(Buffer.from(r.bytes.subarray(1)).toString("latin1")).toMatch(/^[A-Z]+$/);
      expect(Buffer.from(sealedReplacement(name, "native").bytes).equals(Buffer.from(r.bytes))).toBe(true);
    }
  });
  test("a JS member read `.NAME` becomes a computed read of a key holding U+0000, valid as an assignment target too", () => {
    for (const name of SEALED_ENV_NAMES) {
      const r = sealedReplacement(name, "member");
      expect(r.offset).toBe(-1);
      expect(r.bytes.length).toBe(name.length + 1);
      const code = Buffer.from(r.bytes).toString("latin1");
      const env: Record<string, string> = { [name]: "set" };
      expect(new Function("env", `return env${code}`)(env)).toBeUndefined();
      expect(() => new Function("env", `env${code} = ""; return 1`)).not.toThrow();
      expect((new Function(`return Object.keys({}${code} === undefined ? { k: 1 } : {})`)() as string[])).toEqual(["k"]);
      expect(code.startsWith('["\\0')).toBe(true);
    }
  });
  test("a quoted JS name becomes a string holding U+0000", () => {
    for (const name of SEALED_ENV_NAMES) {
      const r = sealedReplacement(name, "quoted");
      expect(r.bytes.length).toBe(name.length);
      expect(new Function(`return "${Buffer.from(r.bytes).toString("latin1")}"`)()).toBe(`\0${sealFiller(name, name.length - 2)}`);
    }
  });
});

describe("sealBunDoors", () => {
  for (const [format, make] of [["macho", macho], ["elf", elf], ["pe", pe]] as const) {
    test(`${format}: every name outside the module graph becomes its token, and the graph is untouched`, () => {
      const bytes = make(NATIVE, GRAPH);
      const graph = moduleGraphRange(bytes);
      expect(graph.format).toBe(format);
      const graphBefore = bytes.slice(graph.start, graph.end);
      expect(sealProblems(bytes).length).toBeGreaterThan(0);
      const r = sealBunDoors(bytes);
      expect(r.alreadySealed).toBe(false);
      expect(r.sealed).toEqual({ BUN_INSPECT_CONNECT_TO: 1, BUN_INSPECT_PRELOAD: 1, BUN_INSPECT_NOTIFY: 2, BUN_INSPECT: 1, BUN_OPTIONS: 1, BUN_BE_BUN: 1, NODE_PATH: 2 });
      expect(Buffer.from(bytes.slice(graph.start, graph.end)).equals(Buffer.from(graphBefore))).toBe(true);
      expect(sealProblems(bytes)).toEqual([]);
      // Nothing else moved: the separators and the neighbours are where they were.
      const native = Buffer.from(bytes.subarray(0, graph.start)).toString("latin1");
      expect(native).toContain(`\0NO_COLOR\0\0${sealFiller("BUN_BE_BUN", 9)}\0BUN_INSTRUMENTS\0`);
      expect(native).toContain(`Bun.env["\\0${sealFiller("NODE_PATH", 4)}"], x`);
      expect(native).toContain(`process.env["\\0${sealFiller("BUN_INSPECT_NOTIFY", 13)}"] = ""`);
      expect(native).toContain(`"\\0${sealFiller("NODE_PATH", 7)}",`);
      expect(native).toContain("NODE_CHANNEL_FD");
      // The bundle still names every one (its refusals list is the app's, not Bun's).
      for (const name of ["NODE_PATH", "BUN_OPTIONS", "BUN_INSPECT", "BUN_BE_BUN"]) expect(count(bytes, name)).toBe(1);
    });
  }

  test("sealing twice changes nothing and says so", () => {
    const bytes = elf(NATIVE, GRAPH);
    sealBunDoors(bytes);
    const once = bytes.slice();
    expect(sealBunDoors(bytes).alreadySealed).toBe(true);
    expect(Buffer.from(bytes).equals(Buffer.from(once))).toBe(true);
  });

  test("a Bun that no longer names a door where this looks fails the build (a new Bun needs a new audit)", () => {
    for (const missing of REQUIRED_NATIVE_NAMES) {
      const native = NATIVE.replaceAll(missing, "X".repeat(missing.length));
      expect(() => sealBunDoors(elf(native, GRAPH))).toThrow("audit the new Bun");
    }
  });

  test("a binary with no module graph is refused, never sealed blind", () => {
    expect(() => moduleGraphRange(enc.encode(`#!/bin/sh\n${NATIVE}`))).toThrow("not a Mach-O, ELF or PE");
    expect(() => moduleGraphRange(elf(NATIVE, GRAPH).fill(0, 0x3c, 0x3e))).toThrow("no .bun section");
  });

  test("the byte check names what is left", () => {
    const bytes = pe(NATIVE, GRAPH);
    const problems = sealProblems(bytes);
    expect(problems.some((p) => p.startsWith("BUN_BE_BUN is still in Bun's code"))).toBe(true);
    expect(problems.some((p) => p.includes("sealed token is missing"))).toBe(true);
  });
});
