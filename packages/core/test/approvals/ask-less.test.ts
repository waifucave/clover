// "Bots are supposed to be autonomous most of the time" (the owner, November 10): at ask for risky actions a bot's
// change to an ordinary file of the user's, a fetch of an address its conversation already saw, and Clover's own core
// tools run without a card; a sensitive place, a made-up address and anything else go to the safety reviewer, and to
// a card when it can't say "safe". The fence, rule 3, unresolved paths and read only come first, unchanged.
import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, Level, Os } from "@waifucave/clover-protocol";
import { CloverApprovalBroker, type CloverApprovalRequest } from "../../src/approvals/broker";
import { botApprovalCheck, CORE_TOOL_RULES, type BundledToolKind } from "../../src/approvals/bot-check";
import { allOrdinary, allOrdinaryOnDisk, isOrdinaryPath } from "../../src/approvals/ordinary-paths";
import { requestReviewer, reviewInputOf } from "../../src/approvals/request-reviewer";
import { normalUrl, SeenUrls, urlsIn } from "../../src/approvals/seen-urls";
import { resolveSessionPath } from "../../src/approvals/bot-check";
import type { ApprovalRequest, Reviewer } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { BotSessionContext } from "../../src/bots/service";
import type { TurnInput } from "../../src/contracts/session-host";

const mac = (home = "/Users/k") => ({ home, os: "macos" as Os });

describe("ordinary files: the user's own folders, never logins, settings, apps or outside the home", () => {
  test("macOS: Documents, Downloads, Desktop and a project folder are ordinary; the rest isn't", () => {
    for (const p of ["/Users/k/Downloads/notes.md", "/Users/k/Documents/a/b.txt", "/Users/k/Desktop/x", "/Users/k/code/proj/src/main.ts"]) {
      expect([p, isOrdinaryPath(p, mac())]).toEqual([p, true]);
    }
    for (const p of [
      "/Users/k", "/Users/k/.ssh/config", "/Users/k/.aws/credentials", "/Users/k/.kube/config", "/Users/k/.docker/config.json", "/Users/k/.netrc",
      "/Users/k/.config/x", "/Users/k/Library/Keychains/login.keychain-db", "/Users/k/Library/Application Support/x", "/Users/k/Library/Preferences/p.plist",
      "/Users/k/Applications/Tool.app/Contents/Info.plist", "/Users/k/Downloads/Thing.app/Contents/MacOS/x", "/Applications/X.app/Contents/x",
      "/etc/hosts", "/tmp/x", "/Users/other/Documents/x", "/Users/kk/Documents/x", "relative/x", "/Users/k/Documents/../.ssh/x", "/Users/k/./Documents/x",
    ]) {
      expect([p, isOrdinaryPath(p, mac())]).toEqual([p, false]);
    }
  });

  test("names are compared as the disk compares them: case, Unicode form, Windows' trailing dots and short names", () => {
    // macOS folds case and Unicode form.
    for (const p of ["/Users/k/LIBRARY/Keychains/x", "/users/K/library/x", "/Users/k/Downloads/Tool.APP/x", "/USERS/K/.SSH/x"]) expect([p, isOrdinaryPath(p, mac())]).toEqual([p, false]);
    expect(isOrdinaryPath("/USERS/K/Documents/x", mac())).toBe(true);
    const nfd = "/Users/Jose\u0301/Documents/x";
    expect(isOrdinaryPath(nfd, mac("/Users/Jos\u00e9"))).toBe(true);
    expect(isOrdinaryPath("/Users/Jose\u0301/Library/x", mac("/Users/Jos\u00e9"))).toBe(false);
    // Linux is case-sensitive: `Library` there is an ordinary folder name; dot-folders aren't.
    expect(isOrdinaryPath("/home/k/Library/x", { home: "/home/k", os: "linux" })).toBe(true);
    expect(isOrdinaryPath("/home/k/.config/systemd/x", { home: "/home/k", os: "linux" })).toBe(false);
    expect(isOrdinaryPath("/HOME/k/Documents/x", { home: "/home/k", os: "linux" })).toBe(false);
    // Windows: case, trailing dots and spaces, 8.3 short names, AppData.
    const win = { home: "C:\\Users\\k", os: "windows" as Os };
    expect(isOrdinaryPath("C:\\Users\\k\\Documents\\a.txt", win)).toBe(true);
    expect(isOrdinaryPath("c:/USERS/K/Documents/a.txt", win)).toBe(true);
    for (const p of ["C:\\Users\\k\\AppData\\Roaming\\x", "C:\\Users\\k\\APPDATA. \\x", "C:\\Users\\k\\APPDAT~1\\x", "C:\\Users\\k\\.ssh\\x", "D:\\Users\\k\\Documents\\x"]) {
      expect([p, isOrdinaryPath(p, win)]).toEqual([p, false]);
    }
  });

  test("the Clover home is never ordinary, wherever it is; an empty list is never ordinary", () => {
    const o = { ...mac(), cloverHome: "/Users/k/CloverData" };
    expect(isOrdinaryPath("/Users/k/CloverData/bots/x", o)).toBe(false);
    expect(isOrdinaryPath("/Users/k/CloverData", o)).toBe(false);
    expect(isOrdinaryPath("/Users/k/CloverDataX/x", o)).toBe(true);
    expect(allOrdinary([], o)).toBe(false);
    expect(allOrdinary(undefined, o)).toBe(false);
    expect(allOrdinary(["/Users/k/Documents/a", "/Users/k/.ssh/b"], o)).toBe(false);
  });

  test("on the disk: a link from an ordinary folder into a sensitive one is judged where it leads, a new name too", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-ordinary-")));
    mkdirSync(join(home, "Downloads"));
    mkdirSync(join(home, ".ssh"));
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    symlinkSync(join(home, ".ssh"), join(home, "Downloads", "keys"));
    symlinkSync(join(home, "Library"), join(home, "Downloads", "lib"));
    const os: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    const judged = (p: string) => isOrdinaryPath(resolveSessionPath(p, home, home), { home, os });
    expect(judged(join(home, "Downloads", "notes.md"))).toBe(true);
    expect(judged(join(home, "Downloads", "keys", "authorized_keys"))).toBe(false);
    expect(judged(join(home, "Downloads", "keys", "new", "deep.txt"))).toBe(false);
    expect(judged(join(home, "Downloads", "lib", "Keychains", "x"))).toBe(false);
    expect(judged("~/Downloads/x.md".replace("~", home))).toBe(true);
    expect(judged(join(home, "Downloads", "..", ".ssh", "x"))).toBe(false);
    // A hard link no real path shows: a file in Downloads that is also `~/.ssh/authorized_keys` is never ordinary.
    writeFileSync(join(home, ".ssh", "authorized_keys"), "k\n");
    linkSync(join(home, ".ssh", "authorized_keys"), join(home, "Downloads", "innocent.txt"));
    writeFileSync(join(home, "Downloads", "plain.txt"), "p\n");
    expect(allOrdinaryOnDisk([join(home, "Downloads", "plain.txt"), join(home, "Downloads", "new.txt")], { home, os })).toBe(true);
    expect(allOrdinaryOnDisk([join(home, "Downloads", "innocent.txt")], { home, os })).toBe(false);
    expect(allOrdinaryOnDisk([join(home, ".ssh", "x")], { home, os })).toBe(false);
    if (os === "macos") {
      // A case variant of a sensitive folder on a case-insensitive disk.
      expect(judged(join(home, "LIBRARY", "Keychains", "x"))).toBe(false);
      expect(judged(join(home, "downloads", "keys", "x"))).toBe(false);
    }
  });
});

const ORDINARY_HOME = "/Users/k";
const editOf = (paths: string[], over: Partial<CloverApprovalRequest> = {}): CloverApprovalRequest => ({
  kind: "tool", session: "s1", bot: "luna", origin: "user", computers: ["Studio"], effect: "edit", paths,
  fields: { title: { type: "text", text: "Change files" } }, ...over,
});

function brokerAt(level: Level, reviewer?: Reviewer, over: Partial<ConstructorParameters<typeof CloverApprovalBroker>[0]> = {}) {
  return new CloverApprovalBroker({
    clock: new FakeClock(), levels: () => level, localComputer: "Studio",
    ordinaryPaths: (paths) => allOrdinary(paths, mac(ORDINARY_HOME)),
    ...(reviewer === undefined ? {} : { reviewer }), ...over,
  });
}

/** The next card's answer, through the app's sealed frame. */
function answerNext(b: CloverApprovalBroker, optionId: string): Promise<Card> {
  return new Promise((resolve) => {
    const off = b.watch((e) => {
      if (e.type !== "requested") return;
      off();
      void b.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: b.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
    });
  });
}

describe("the broker at ask for risky actions", () => {
  test("an edit of ordinary files runs with no card and no reviewer; a sensitive one goes to the reviewer, then a card", async () => {
    let reviewed = 0;
    const b = brokerAt("ask-risky", async () => { reviewed++; return "unavailable"; });
    expect(await b.request(editOf(["/Users/k/Downloads/notes.md"]))).toEqual({ allowed: true, by: "level", level: "ask-risky" });
    expect(await b.request(editOf(["/Users/k/Documents/a.md", "/Users/k/Desktop/b.md"], { effect: "move" }))).toEqual({ allowed: true, by: "level", level: "ask-risky" });
    expect(reviewed).toBe(0);
    const card = answerNext(b, "deny");
    expect(await b.request(editOf(["/Users/k/Downloads/notes.md", "/Users/k/.aws/credentials"]))).toMatchObject({ allowed: false, by: "card" });
    await card;
    expect(reviewed).toBe(1);
    // The reviewer's "safe" lets a sensitive change through, as at ask-risky before.
    const safe = brokerAt("ask-risky", async () => "safe");
    expect(await safe.request(editOf(["/Users/k/Library/Preferences/p.plist"]))).toEqual({ allowed: true, by: "level", level: "ask-risky" });
  });

  test("a requester's word never makes an edit contained; a delete, a command and an edit with no paths never are", async () => {
    for (const req of [
      editOf(["/Users/k/.ssh/config"], { contained: true }),
      editOf([], { contained: true }),
      editOf(["/Users/k/Downloads/a"], { effect: "delete" }),
      editOf(["/Users/k/Downloads/a"], { effect: "execute", contained: true }),
    ]) {
      const b = brokerAt("ask-risky");
      const card = answerNext(b, "deny");
      expect([req.effect, await b.request(req)]).toMatchObject([req.effect, { allowed: false, by: "card" }]);
      await card;
    }
  });

  test("the stricter levels and the rules before the level are unchanged", async () => {
    // ask: a card; read only: refused; accept edits: runs, sensitive places too.
    const ask = brokerAt("ask");
    const card = answerNext(ask, "deny");
    expect(await ask.request(editOf(["/Users/k/Downloads/a.md"]))).toMatchObject({ allowed: false, by: "card" });
    await card;
    expect(await brokerAt("read-only").request(editOf(["/Users/k/Downloads/a.md"]))).toEqual({ allowed: false, by: "level", level: "read-only" });
    expect(await brokerAt("accept-edits").request(editOf(["/Users/k/.aws/config"]))).toEqual({ allowed: true, by: "level", level: "accept-edits" });
    // A path another computer's session gave (unresolved), or an edit on another computer: a card.
    for (const req of [editOf(["/Users/k/Downloads/a.md"], { pathsUnresolved: true }), editOf(["/Users/k/Downloads/a.md"], { computers: ["Laptop"] })]) {
      const b = brokerAt("ask-risky");
      const c = answerNext(b, "deny");
      expect(await b.request(req)).toMatchObject({ allowed: false, by: "card" });
      await c;
    }
    // A path the fence touches (rule 3): a card, ordinary or not.
    const fenced = brokerAt("ask-risky", undefined, { fence: () => ({ touches: (paths) => (paths.length > 0 ? { kind: "settings", path: paths[0]! } as never : null) }) });
    const c = answerNext(fenced, "deny");
    expect(await fenced.request(editOf(["/Users/k/Downloads/a.md"]))).toMatchObject({ allowed: false, by: "card" });
    await c;
    // Without the path check (a broker given none), an edit is judged as before: the reviewer, then a card.
    const none = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask-risky", localComputer: "Studio" });
    const d = answerNext(none, "deny");
    expect(await none.request(editOf(["/Users/k/Downloads/a.md"]))).toMatchObject({ allowed: false, by: "card" });
    await d;
  });

  test("a contained fetch or tool runs; one that isn't goes to the reviewer; read only still refuses a contained one", async () => {
    const fetch = (contained: boolean): ApprovalRequest => ({ kind: "tool", bot: "luna", origin: "user", computers: ["Studio"], effect: "fetch", ...(contained ? { contained } : {}), fields: {} });
    let reviewed = 0;
    const b = brokerAt("ask-risky", async () => { reviewed++; return "safe"; });
    expect(await b.request(fetch(true))).toEqual({ allowed: true, by: "level", level: "ask-risky" });
    expect(reviewed).toBe(0);
    expect(await b.request(fetch(false))).toEqual({ allowed: true, by: "level", level: "ask-risky" });
    expect(reviewed).toBe(1);
    expect(await brokerAt("read-only").request(fetch(true))).toEqual({ allowed: false, by: "level", level: "read-only" });
  });
});

describe("the reviewer the broker asks", () => {
  test("it is shown what the card shows: a command, a change's paths, a tool as a line; it fails closed", async () => {
    expect(reviewInputOf({ kind: "tool", bot: "luna", origin: "user", computers: ["Studio"], effect: "execute", fields: { command: { type: "code", code: "ls -la" } } }))
      .toEqual({ class: "bash", command: "ls -la", justification: "The bot luna on Studio asks." });
    expect(reviewInputOf({ kind: "agent-permission", origin: "user", computers: ["Studio"], effect: "execute", fields: {}, agent: { rawInput: { command: "make" } } as never }))
      .toMatchObject({ class: "bash", command: "make" });
    expect(reviewInputOf(editOf(["/Users/k/.aws/config"]))).toEqual({ class: "fs", precis: "edit /Users/k/.aws/config (The bot luna on Studio asks.)" });
    expect(reviewInputOf({ kind: "tool", origin: "user", computers: ["Studio"], effect: "fetch", fields: { title: { type: "text", text: "Fetch a web page" }, detail: { type: "code", code: "{\"url\":\"https://x.example/a\"}" } } }))
      .toMatchObject({ class: "external" });
    const req = editOf(["/Users/k/.aws/config"]);
    expect(await requestReviewer(undefined)(req)).toBe("unavailable");
    expect(await requestReviewer({ review: async () => ({ verdict: "safe", reason: "" }) })(req)).toBe("safe");
    expect(await requestReviewer({ review: async () => ({ verdict: "unsafe", reason: "" }) })(req)).toBe("risky");
    const lines: string[] = [];
    expect(await requestReviewer({ review: async () => { throw new Error("no model"); } }, (l) => lines.push(l))(req)).toBe("unavailable");
    expect(lines).toHaveLength(1);
  });
});

describe("addresses the conversation already saw", () => {
  const user = (text: string, over: Record<string, unknown> = {}): TurnInput => ({ from: "user", text, device: "d", sentAt: 1, clientMessageId: "m", ...over }) as TurnInput;

  test("from the user's own message and the web tools' results; never from another bot's message", () => {
    const s = new SeenUrls();
    s.input("s1", user("read https://news.example/story?id=7 and https://docs.example/guide."));
    s.input("s1", { from: "bot", text: "https://evil.example/x", bot: "sol" } as unknown as TurnInput);
    s.input("s1", user("https://relayed.example/a", { relayed: { signed: false } }));
    s.result("s1", { content: [{ type: "text", text: "1. Title — https://found.example/page\n[link](https://linked.example/p?q=1)" }] });
    expect(s.seen("s1", "https://news.example/story?id=7")).toBe(true);
    expect(s.seen("s1", "https://news.example/story")).toBe(true); // same origin and path, no query
    expect(s.seen("s1", "https://news.example/story?id=8")).toBe(false); // another query
    expect(s.seen("s1", "https://docs.example/guide")).toBe(true); // the sentence's full stop isn't the address
    expect(s.seen("s1", "https://docs.example/guide#part-2")).toBe(true); // the fragment never matters
    expect(s.seen("s1", "https://DOCS.example:443/guide")).toBe(true); // the host's case and the default port
    expect(s.seen("s1", "https://docs.example/guide/secret-data")).toBe(false); // a made-up path
    expect(s.seen("s1", "https://found.example/page")).toBe(true);
    expect(s.seen("s1", "https://linked.example/p?q=1")).toBe(true);
    expect(s.seen("s1", "https://evil.example/x")).toBe(false);
    expect(s.seen("s1", "https://relayed.example/a")).toBe(false);
    expect(s.seen("s2", "https://news.example/story")).toBe(false); // another conversation
    expect(s.seen("s1", "http://news.example/story")).toBe(false); // another scheme is another origin
    s.forget("s1");
    // Bounded: the conversation used longest ago goes first.
    const many = new SeenUrls();
    for (let i = 0; i <= 200; i++) many.input(`c${i}`, user(`https://x${i}.example/`));
    expect(many.seen("c0", "https://x0.example/")).toBe(false);
    expect(many.seen("c200", "https://x200.example/")).toBe(true);
    expect(s.seen("s1", "https://docs.example/guide")).toBe(false);
  });

  test("only http and https, no credentials in the address; text is scanned with a bound", () => {
    expect(normalUrl("ftp://x.example/a")).toBeNull();
    expect(normalUrl("https://u:p@x.example/a")).toBeNull();
    expect(normalUrl("not a url")).toBeNull();
    expect(urlsIn("see (https://a.example/x) and <https://b.example/y>")).toEqual(["https://a.example/x", "https://b.example/y"]);
  });
});

describe("a bot's calls: what Clover knows beyond a tool's name", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-askless-")));
  const ctx = { botId: "luna", sessionId: "s1", computer: "Studio", paths: { scratch }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } } as unknown as BotSessionContext;
  const requests: ApprovalRequest[] = [];
  const recorder = { request: async (r: ApprovalRequest) => { requests.push(r); return { allowed: false, by: "card" as const }; } };
  const seen = new SeenUrls();
  seen.input("s1", { from: "user", text: "https://given.example/a", device: "d", sentAt: 1, clientMessageId: "m" } as TurnInput);
  const bundled = (_: BotSessionContext, tool: string): BundledToolKind | undefined =>
    tool === "mcp__web__WebSearch" ? "web-search" : tool === "mcp__web__WebFetch" ? "web-fetch" : undefined;
  const check = botApprovalCheck(recorder, {
    hostTools: () => ["SendMessage", "ListAgents", "TaskStop", "Agent", "Glossary"], bundledTool: bundled, seenUrl: (c, u) => seen.seen(c.sessionId, u),
  });
  const call = async (tool: string, input: Record<string, unknown>) => {
    requests.length = 0;
    await check(ctx, () => "user")(tool, input, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    return requests[0]!;
  };

  test("the core tools: listing is a read; a message, stopping a task and starting an agent are contained", async () => {
    expect(await call("ListAgents", {})).toMatchObject({ effect: "read" });
    for (const t of ["SendMessage", "TaskStop", "Agent"]) expect([t, await call(t, { to: "x" })]).toMatchObject([t, { effect: "other", contained: true }]);
    expect([...CORE_TOOL_RULES.keys()].sort()).toEqual(["Agent", "ListAgents", "SendMessage", "TaskStop"]);
    // Not the host's: a plugin's tool of the same name is a tool, judged as one.
    expect((await call("mcp__x__SendMessage", {})).contained).toBeUndefined();
  });

  test("the bundled web tools: a search is a search; a fetch of a seen address is contained, a made-up one isn't", async () => {
    expect(await call("mcp__web__WebSearch", { query: "q" })).toMatchObject({ effect: "search" });
    const given = await call("mcp__web__WebFetch", { url: "https://given.example/a" });
    expect(given).toMatchObject({ effect: "fetch", contained: true, fields: { title: { type: "text", text: "Fetch a web page" } } });
    const composed = await call("mcp__web__WebFetch", { url: "https://given.example/a?leak=secret" });
    expect(composed).toMatchObject({ effect: "fetch" });
    expect(composed.contained).toBeUndefined();
    // Another plugin's WebFetch is a tool, however it is named.
    const other = await call("mcp__web2__WebFetch", { url: "https://given.example/a" });
    expect(other).toMatchObject({ effect: "other" });
    expect(other.contained).toBeUndefined();
  });
});
