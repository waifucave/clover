// The harness that runs lane B's Tree conformance suite against the real tree (`src/tree/`).
//
// The suite drives one Tree that holds every computer's files, with the fake's options: POSIX home paths like
// `/Users/me`, a FakeFence per computer, a level per computer and an on/off switch. The real tree serves each
// computer's part through that computer's own holder. Here every computer is a `LocalHolder` on its own temp folder
// (`<temp>/Users/me`), so a call runs as the computer that holds the files would run it, the user's own calls
// included; calls between computers over the link have tests of their own (`cluster.test.ts`). The harness only
// translates paths: the suite's `/Users/me/…` is `<temp>/Users/me/…` on this disk, both in what `resolve` returns and in
// what each fence is asked.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DEFAULT_LEVEL, type Level } from "@waifucave/clover-protocol";
import type { AnswerDevices } from "../../src/contracts/approval-broker";
import type { Fence } from "../../src/contracts/fence";
import { MemoryAnswerLedger } from "../../src/contracts/fakes/approval-broker";
import type { FakeTree, FakeTreeComputer } from "../../src/contracts/fakes/tree";
import type { TreeHarness } from "../../src/contracts/conformance/tree";
import { LocalHolder } from "../../src/tree/holder";
import { localTransfer } from "../../src/tree/transfer";
import { hostOs } from "../../src/tree/names";
import { CoreTree, type TreeComputer } from "../../src/tree/tree";

const NO_DEVICES: AnswerDevices = { get: () => undefined, verifyAnswer: async () => false };

export function realTreeHarness(opts: ConstructorParameters<typeof FakeTree>[0]): TreeHarness {
  const disk = realpathSync.native(mkdtempSync(join(tmpdir(), "lane-j-tree-")));
  // The suite's POSIX paths, on this disk and back (Windows included: `\` and a drive letter there).
  const toDisk = (p: string) => join(disk, ...p.split("/").filter(Boolean));
  const fromDisk = (p: string) => {
    const rel = relative(disk, p);
    if (rel === "") return "/";
    return rel.startsWith("..") ? p : `/${rel.split(sep).join("/")}`;
  };
  // Each holder keeps its own ledger of used answers, the suite's when it names one (R15 checks one answer at each end).
  const answersFor = (name: string) => ({
    devices: opts.devices ?? NO_DEVICES, ledger: opts.ledgers?.[name] ?? new MemoryAnswerLedger(), render: opts.render ?? (() => undefined),
  });
  const computers = new Map<string, TreeComputer>();
  const holders = new Map<string, LocalHolder>();
  let self: string | undefined;

  const directory = {
    self: () => self!,
    get(nameOrAlias: string): TreeComputer | undefined {
      const c = computers.get(nameOrAlias) ?? [...computers.values()].find((x) => x.aliases.includes(nameOrAlias));
      return c ? { ...c } : undefined;
    },
  };
  const tree = new CoreTree({
    directory,
    holder: (name) => holders.get(name)!,
    botComputer: opts.botComputer,
    // Both ends on this disk: the direct path between two holders here.
    transfer: ({ from, to, move, source, destination, call }) => localTransfer(holders.get(source)!, holders.get(destination)!, {
      from, to, move, level: call.level ?? DEFAULT_LEVEL, ...(call.answer ? { answer: call.answer } : {}),
    }, call.as),
  });

  const addComputer = (name: string, c: FakeTreeComputer): void => {
    self ??= name;
    const home = toDisk(c.home);
    const botsRoot = toDisk(c.botsRoot ?? `${c.home}/.clover/bots`);
    mkdirSync(home, { recursive: true });
    const fence = c.fence;
    const state: TreeComputer = { name, aliases: c.aliases ?? [], online: c.online ?? true, level: c.level ?? DEFAULT_LEVEL, home, botsRoot, os: hostOs() };
    computers.set(name, state);
    holders.set(name, new LocalHolder({
      clock: opts.clock,
      name: () => name,
      aliases: () => state.aliases,
      home,
      botsRoot,
      runsBot: (bot) => opts.botComputer(bot) === name,
      level: () => computers.get(name)!.level,
      answers: answersFor(name),
      ...(fence ? {
        fence: {
          check: (op, ctx) => fence.check(op.op === "move" ? { ...op, path: fromDisk(op.path), to: fromDisk(op.to) } : { ...op, path: fromDisk(op.path) }, ctx),
          // The folded check (review B1) compares the fenced set on this disk.
          fencedSet: () => (typeof (fence as Partial<Fence>).fencedSet === "function" ? (fence as Fence).fencedSet().map((i) => ({ ...i, path: toDisk(i.path) })) : []),
        } satisfies Pick<Fence, "check" | "fencedSet">,
      } : {}),
    }));
  };
  for (const [name, c] of Object.entries(opts.computers)) addComputer(name, c);

  return {
    addComputer,
    setOnline: (name: string, online: boolean) => { const c = computers.get(name); if (c) c.online = online; },
    setLevel: (name: string, level: Level) => { const c = computers.get(name); if (c) c.level = level; },
    resolve: (path) => { const loc = tree.resolve(path); return { ...loc, path: fromDisk(loc.path) }; },
    toTreePath: (computer, realPath) => tree.toTreePath(computer, toDisk(realPath)),
    stat: (path, o) => tree.stat(path, o),
    read: (path, o) => tree.read(path, o),
    write: (path, data, o) => tree.write(path, data, o),
    list: (path, o) => tree.list(path, o),
    remove: (path, o) => tree.remove(path, o),
    move: (from, to, o) => tree.move(from, to, o),
    glob: (pattern, o) => tree.glob(pattern, o),
    grep: (pattern, o) => tree.grep(pattern, o),
    computersFor: (paths) => tree.computersFor(paths),
    watch: (path, o, fn) => tree.watch(path, o, fn),
  };
}
