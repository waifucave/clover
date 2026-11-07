import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, TurnOrigin } from "@waifucave/clover-protocol";
import { CloverApprovalBroker, RESOLVED_KEEP_MS, UNRESOLVED_PATHS_REASON, type CloverApprovalRequest } from "../../src/approvals/broker";
import { botApprovalCheck, botToolRequest, effectOf, isBuiltinTool, resolveSessionPath, ruleKeyOf } from "../../src/approvals/bot-check";
import { fileRuleStore, savedRulesPath } from "../../src/approvals/rule-store";
import { looksCredentialBearing, plainOf, ruleDisplay, ruleKeyHash, shownCode } from "../../src/approvals/strings";
import type { Clock } from "../../src/contracts/clock";
import { runApprovalBrokerConformance } from "../../src/contracts/conformance/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { ApprovalRequest, Reviewer } from "../../src/contracts/approval-broker";
import type { BotSessionContext } from "../../src/bots/service";

// B's suite: every rule of the contract, against the real broker.
runApprovalBrokerConformance((opts) => new CloverApprovalBroker(opts));

const home = () => mkdtempSync(join(tmpdir(), "clover-approvals-"));
const clockAt = () => new FakeClock();
const bash = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  kind: "tool", session: "s1", bot: "luna", origin: "user", computers: ["Studio"], effect: "execute", ruleKey: "Bash(git push)",
  fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "git push", language: "sh" } }, ...over,
});

const FRAME_OF = (b: CloverApprovalBroker, c: Card) => ({ via: "sealed-frame" as const, frame: b.frameChannel(c.id) ?? "frame_gone", input: "click" as const, at: 1 });

/** Answers the next card through the app's sealed frame, as the app's main process does. */
function answerNext(b: CloverApprovalBroker, optionId: string): Promise<Card> {
  return new Promise((resolve) => {
    const off = b.watch((e) => {
      if (e.type !== "requested") return;
      off();
      void b.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: b.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
    });
  });
}

describe("the real broker's saved rules and records", () => {
  test("an \"always\" is saved owner-only as a hash and a display string, and holds after a restart", async () => {
    const h = home(), clock = clockAt();
    const first = new CloverApprovalBroker({ clock, rules: fileRuleStore(h) });
    const answered = answerNext(first, "always");
    expect(await first.request(bash())).toMatchObject({ allowed: true, by: "card", remembered: true });
    await answered;
    const doc = JSON.parse(readFileSync(savedRulesPath(h), "utf8"));
    expect(doc).toEqual({ version: 2, rules: [{ keyHash: ruleKeyHash("Bash(git push)"), display: "Bash(git push)", computers: ["Studio"], cardId: expect.any(String), savedAt: expect.any(Number) }] });
    expect(JSON.stringify(doc)).not.toContain("ruleKey");
    if (process.platform !== "win32") {
      expect(statSync(savedRulesPath(h)).mode & 0o777).toBe(0o600);
      expect(statSync(join(h, "rules")).mode & 0o777).toBe(0o700);
    }
    const again = new CloverApprovalBroker({ clock, rules: fileRuleStore(h) });
    expect(again.rules()).toMatchObject([{ ruleKey: "Bash(git push)", computers: ["Studio"] }]);
    expect(await again.request(bash())).toEqual({ allowed: true, by: "rule" });
    // Not on another computer, and not another command.
    const other = answerNext(again, "deny");
    expect(await again.request(bash({ computers: ["Laptop"] }))).toMatchObject({ allowed: false, by: "card" });
    await other;
    const another = answerNext(again, "deny");
    expect(await again.request(bash({ ruleKey: "Bash(git push --force)" }))).toMatchObject({ allowed: false, by: "card" });
    await another;
  });

  test("a rule matches only a request that names a computer", async () => {
    const b = new CloverApprovalBroker({ clock: clockAt() });
    const saved = answerNext(b, "always");
    await b.request(bash());
    await saved;
    let card: Card | undefined;
    const off = b.watch((e) => { if (e.type === "requested") card = e.card; });
    const shown = answerNext(b, "deny");
    expect(await b.request(bash({ computers: [] }))).toMatchObject({ allowed: false, by: "card" });
    await shown;
    off();
    expect(card!.options.map((o) => o.id)).toEqual(["approve", "deny"]); // and no "always" is offered for it
  });

  test("a damaged or old rules file loads as no rules, and the log line is fixed (never the parse error)", async () => {
    for (const text of ['{"version":1,"rules":[{"ruleKey":"Bash(curl -H \'Authorization: Bearer s3cr3t-value\')"}]}', "{ not json Bearer s3cr3t-value"]) {
      const h = home();
      mkdirSync(join(h, "rules"), { recursive: true });
      writeFileSync(savedRulesPath(h), text);
      const lines: string[] = [];
      const b = new CloverApprovalBroker({ clock: clockAt(), rules: fileRuleStore(h), log: (l) => lines.push(l) });
      expect(b.rules()).toEqual([]);
      expect(lines).toEqual(["[approvals] the saved rules file is unreadable; starting with no saved rules"]);
    }
  });

  test.skipIf(process.platform === "win32")("the store never writes or reads through a link, and keeps its folder owner-only", async () => {
    const h = home(), elsewhere = join(home(), "target.json");
    writeFileSync(elsewhere, "untouched");
    mkdirSync(join(h, "rules"), { recursive: true, mode: 0o755 });
    chmodSync(join(h, "rules"), 0o755);
    symlinkSync(elsewhere, savedRulesPath(h));
    const lines: string[] = [];
    const b = new CloverApprovalBroker({ clock: clockAt(), rules: fileRuleStore(h), log: (l) => lines.push(l) });
    expect(lines).toEqual(["[approvals] the saved rules file is unreadable; starting with no saved rules"]);
    const saved = answerNext(b, "always");
    await b.request(bash());
    await saved;
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(lstatSync(savedRulesPath(h)).isSymbolicLink()).toBe(false);
    expect(statSync(join(h, "rules")).mode & 0o777).toBe(0o700);
  });

  test("a key that looks like it carries a credential is never offered \"always\" nor saved", async () => {
    const h = home();
    const b = new CloverApprovalBroker({ clock: clockAt(), rules: fileRuleStore(h) });
    const key = "Bash(curl -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com)";
    let card: Card | undefined;
    b.watch((e) => { if (e.type === "requested") card = e.card; });
    const pending = b.request(bash({ ruleKey: key }));
    await Bun.sleep(0);
    expect(card!.options.map((o) => o.id)).toEqual(["approve", "deny"]);
    expect(await b.answer(card!.id, { optionId: "always", hash: card!.hash, proof: { via: "sealed-frame", frame: b.frameChannel(card!.id)!, input: "click", at: 1 } }, { role: "app" })).toBe("bad-option");
    // Even an "always" the request brought itself is taken off.
    const own = b.request(bash({ ruleKey: key, options: [{ id: "ok", kind: "approve", label: "OK" }, { id: "always", kind: "approve", label: "Always", remember: "always" }] }));
    await Bun.sleep(0);
    expect(card!.options.map((o) => o.id)).toEqual(["ok"]);
    b.cancelSession("s1");
    await Promise.all([pending, own]);
    expect(b.rules()).toEqual([]);
  });

  test("paths from a session on another computer are unresolved: a card every time, no rule matched or saved", async () => {
    const b = new CloverApprovalBroker({ clock: clockAt(), localComputer: "Studio", levels: () => "automatic" });
    const read = (over: Partial<ApprovalRequest> = {}) => bash({ effect: "read", ruleKey: "Read", paths: ["/p/a.ts"], computers: ["Laptop"], ...over });
    // The local computer's own paths run as the level says.
    expect(await b.request(read({ computers: ["Studio"] }))).toEqual({ allowed: true, by: "level", level: "automatic" });
    // Another computer's: a card, with no "always" and the table's reason, even at "automatic" and for a read.
    let card: Card | undefined;
    b.watch((e) => { if (e.type === "requested") card = e.card; });
    const first = answerNext(b, "approve");
    expect(await b.request(read())).toMatchObject({ allowed: true, by: "card" });
    await first;
    expect(card!.options.map((o) => o.id)).toEqual(["approve", "deny"]);
    expect(card!.fields.reason).toEqual({ type: "text", text: UNRESOLVED_PATHS_REASON });
    expect(await b.answer(card!.id, { optionId: "always", hash: card!.hash, proof: FRAME_OF(b, card!) }, { role: "app" })).toBe("already-answered");
    // A request marked unresolved by its requester, on any computer, asks too, and a rule saved for its key doesn't
    // match it.
    const asks = new CloverApprovalBroker({ clock: clockAt(), localComputer: "Studio", levels: () => "ask" });
    const edit = bash({ computers: ["Studio"], ruleKey: "Edit(/p/a.ts)", effect: "edit", paths: ["/p/a.ts"] });
    const saved = answerNext(asks, "always");
    expect(await asks.request(edit)).toMatchObject({ allowed: true, remembered: true });
    await saved;
    expect(await asks.request(edit)).toEqual({ allowed: true, by: "rule" });
    const again = answerNext(asks, "deny");
    expect(await asks.request({ ...edit, paths: ["a.ts"], pathsUnresolved: true } as CloverApprovalRequest)).toMatchObject({ allowed: false, by: "card" });
    await again;
    expect(asks.rules().map((r) => r.ruleKey)).toEqual(["Edit(/p/a.ts)"]);
  });

  test("a bot session on another computer sends its paths as given and marked unresolved", () => {
    const remote = { botId: "luna", sessionId: "s2", computer: "Laptop", paths: { scratch: "/nowhere" } } as unknown as BotSessionContext;
    const r = botToolRequest(remote, "user", "Write", { file_path: "notes.md", content: "x" }, { localComputer: "Studio" });
    expect(r).toMatchObject({ paths: ["notes.md"], pathsUnresolved: true, computers: ["Laptop"] });
    expect(r.ruleKey).toBeUndefined();
    const local = botToolRequest({ ...remote, computer: "Studio" } as BotSessionContext, "user", "Bash", { command: "ls" }, { localComputer: "Studio" });
    expect(local.pathsUnresolved).toBeUndefined();
  });

  test("a card past its expiresAt is expired whatever its timer did", async () => {
    let t = 1_000_000;
    const clock: Clock = { now: () => t, monotonic: () => t, setTimeout: () => ({}) as never, clearTimeout: () => {}, status: () => ({ synced: true }) as never };
    const b = new CloverApprovalBroker({ clock });
    let card: Card | undefined;
    b.watch((e) => { if (e.type === "requested") card = e.card; });
    const pending = b.request(bash({ origin: "routine" }));
    await Bun.sleep(0);
    expect(card!.expiresAt).toBe(t + 10 * 60 * 1000);
    t = card!.expiresAt!;
    expect(await b.answer(card!.id, { optionId: "approve", hash: card!.hash, proof: { via: "sealed-frame", frame: "frame_x", input: "click", at: 1 } }, { role: "app" })).toBe("already-answered");
    expect(await pending).toEqual({ allowed: false, by: "expired", cardId: card!.id });
    expect(b.get(card!.id)).toMatchObject({ outcome: "expired" });
    expect(b.cards()).toEqual([]);
  });

  test("a turn stopped while the reviewer judges raises no card and leaves none open", async () => {
    let release!: (v: "safe" | "risky" | "unavailable") => void;
    const reviewer: Reviewer = () => new Promise((r) => { release = r; });
    const b = new CloverApprovalBroker({ clock: clockAt(), levels: () => "ask-risky", reviewer });
    const events: string[] = [];
    b.watch((e) => events.push(e.type));
    const ac = new AbortController();
    const pending = b.request(bash(), { signal: ac.signal });
    await Bun.sleep(0);
    ac.abort();
    release("unavailable");
    expect(await pending).toEqual({ allowed: false, by: "cancelled" });
    expect(b.cards()).toEqual([]);
    expect(b.pending()).toEqual([]);
    expect(events).toEqual([]);
  });

  test("resolved cards stay readable for a day, then go", async () => {
    const clock = clockAt();
    const b = new CloverApprovalBroker({ clock });
    const card = answerNext(b, "deny");
    await b.request(bash());
    const id = (await card).id;
    expect(b.get(id)).toMatchObject({ outcome: "denied" });
    clock.advance(RESOLVED_KEEP_MS + 1);
    const next = answerNext(b, "deny"); // a later resolve prunes
    await b.request(bash());
    await next;
    expect(b.get(id)).toBeUndefined();
  });
});

describe("strings from a model or a plugin", () => {
  test("credential-looking commands", () => {
    for (const c of [
      "curl -H 'Authorization: Bearer abcdefgh12345' https://x", "curl -H \"X-Api-Key: 1234\" https://x", "curl https://x/api?token=abc",
      "curl 'https://x/?a=1&api_key=zzz'", "GITHUB_TOKEN=ghp_abc make", "mysql -u root -psecret db", "mysql -u root -p hunter2 db",
      "psql --password", "tool --password=hunter2", "git clone https://user:pass@example.com/r.git", "curl -u admin:hunter2 https://x",
      "echo AKIAABCDEFGHIJKLMNOP", "export X=ghp_abcdefghijklmnopqrstuvwxyz0123", "echo 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "echo QmFzZTY0U2VjcmV0VG9rZW5WYWx1ZTEyMzQ1Ng==", "curl -H 'Cookie: sid=1' x",
    ]) expect([c, looksCredentialBearing(c)]).toEqual([c, true]);
    for (const c of ["git push", "mkdir -p build/out", "ssh -p 22 host uptime", "ls -la /Users/someone/Projects/MyApp", "bun test", "git log -p -3", "npm run build -- --watch"]) {
      expect([c, looksCredentialBearing(c)]).toEqual([c, false]);
    }
  });

  test("hiding characters: names lose them, code shows them escaped, saved displays are scrubbed", () => {
    expect(plainOf("Re\u202Ead\u200B\n\tx")).toBe("Readx");
    expect(shownCode("rm -rf /tmp/a\u202Etxt.sh\nls")).toBe("rm -rf /tmp/a\\u{202E}txt.sh\nls");
    expect(ruleDisplay("Bash(curl https://x?token=abc123&b=1)")).toBe("Bash(curl https://x?token=…&b=1)");
    expect(ruleDisplay(`Bash(${"x".repeat(500)})`).length).toBe(200);
  });
});

describe("a bot's tool calls through the broker", () => {
  const scratch = realpathSync(home());
  const ctx = { botId: "luna", sessionId: "s1", computer: "Studio", paths: { scratch } } as unknown as BotSessionContext;
  const call = (b: CloverApprovalBroker, tool: string, input: Record<string, unknown>, origin?: TurnOrigin, signal = new AbortController().signal, c = ctx) =>
    botApprovalCheck(b)(c, () => origin)(tool, input, { signal, toolUseID: "t1", requestId: "r1" });

  test("what each tool does comes from the built-in's identity, never a bare name", () => {
    expect([effectOf("Read"), effectOf("Grep"), effectOf("Edit"), effectOf("Bash"), effectOf("WebFetch"), effectOf("mcp__blender__Render")]).toEqual(["read", "search", "edit", "execute", "fetch", "other"]);
    expect(effectOf("mcp__evil__Read")).toBe("other");
    expect(effectOf("constructor")).toBe("other");
    expect(effectOf("Read", new Set(["Read"]))).toBe("other"); // the host serves a tool of that name itself
    expect(isBuiltinTool("Read", new Set(["SendMessage"]))).toBe(true);
    expect(ruleKeyOf("Bash", { command: "git push" }, [])).toBe("Bash(git push)");
    expect(ruleKeyOf("Bash", { command: "curl -H 'Authorization: Bearer abcdefghij' x" }, [])).toBeUndefined();
    expect(ruleKeyOf("Edit", { file_path: "a.ts" }, ["/real/a.ts"])).toBe("Edit(/real/a.ts)");
    expect(ruleKeyOf("Edit", {}, [])).toBeUndefined();
  });

  test("paths resolve against the session's folder, with ~ expanded and links followed", () => {
    expect(resolveSessionPath("notes.md", scratch)).toBe(join(scratch, "notes.md"));
    const fakeHome = realpathSync(home());
    expect(resolveSessionPath("~/x/y.md", scratch, fakeHome)).toBe(join(fakeHome, "x", "y.md"));
    expect(resolveSessionPath("~", scratch, scratch)).toBe(scratch);
    if (process.platform !== "win32") {
      const real = realpathSync(home());
      symlinkSync(real, join(scratch, "via-link"));
      expect(resolveSessionPath("via-link/new/file.md", scratch)).toBe(join(real, "new", "file.md"));
    }
    expect(resolveSessionPath("a.md", scratch, homedir())).toBe(join(scratch, "a.md"));
  });

  test("the card: table strings in text, everything a model or plugin chose in code, hiding characters out", () => {
    const r = botToolRequest(ctx, "user", "Edit", { file_path: "a\u202E.ts", old_string: "x", new_string: "y" });
    expect(r).toMatchObject({ kind: "tool", session: "s1", bot: "luna", computers: ["Studio"], effect: "edit", paths: [join(scratch, "a\u202E.ts")], ruleKey: `Edit(${join(scratch, "a\u202E.ts")})` });
    expect(r.fields.title).toEqual({ type: "text", text: "Change files" });
    expect(r.fields.what).toEqual({ type: "text", text: "Edit" });
    expect(r.fields.paths).toEqual({ type: "code", code: join(scratch, "a.ts") });
    expect(r.fields.computer).toEqual({ type: "code", code: "Studio" });
    expect((r.fields.detail as { code: string }).code).toContain("a\\u{202E}.ts");
    const plugin = botToolRequest({ ...ctx, computer: "Stu\u200Bdio" } as BotSessionContext, "user", "Re\u202Ead", { q: 1 }, { hostTools: new Set(["Re\u202Ead"]) });
    expect(plugin.effect).toBe("other");
    expect(plugin.fields.what).toEqual({ type: "code", code: "Read" });
    expect(plugin.fields.computer).toEqual({ type: "code", code: "Studio" });
    for (const v of Object.values(plugin.fields)) if (v.type === "text") expect(v.text).toBe("Use a tool");
    const cmd = botToolRequest(ctx, "user", "Bash", { command: "echo a\u2066b" });
    expect(cmd.fields.command).toEqual({ type: "code", code: "echo a\\u{2066}b", language: "sh" });
  });

  test("an \"always\" for a file in one session's folder never allows the same name in another's", async () => {
    const b = new CloverApprovalBroker({ clock: clockAt(), levels: () => "ask" });
    const other = { ...ctx, paths: { scratch: realpathSync(home()) } } as unknown as BotSessionContext;
    const first = answerNext(b, "always");
    expect(await call(b, "Write", { file_path: "notes.md", content: "x" }, "user")).toMatchObject({ behavior: "allow" });
    await first;
    expect(await call(b, "Write", { file_path: "notes.md", content: "y" }, "user")).toMatchObject({ behavior: "allow" });
    const second = answerNext(b, "deny");
    expect(await call(b, "Write", { file_path: "notes.md", content: "z" }, "user", undefined, other)).toEqual({ behavior: "deny", message: "Write was refused: the person declined it." });
    await second;
  });

  test("a read runs at once at the default level; a command waits for the card and runs only on approve", async () => {
    const b = new CloverApprovalBroker({ clock: clockAt() });
    expect(await call(b, "Read", { file_path: "/p/a.ts" }, "user")).toEqual({ behavior: "allow", updatedInput: { file_path: "/p/a.ts" } });
    const shown = answerNext(b, "approve");
    expect(await call(b, "Bash", { command: "git push" }, "user")).toEqual({ behavior: "allow", updatedInput: { command: "git push" } });
    expect((await shown).fields.command).toEqual({ type: "code", code: "git push", language: "sh" });
    const denied = answerNext(b, "deny");
    expect(await call(b, "Bash", { command: "rm -rf build" }, "user")).toEqual({ behavior: "deny", message: "Bash was refused: the person declined it." });
    await denied;
    const plugin = answerNext(b, "deny");
    expect(await call(b, "mcp__x__Read", {}, "user")).toEqual({ behavior: "deny", message: "The tool was refused: the person declined it." });
    await plugin;
  });

  test("a turn of unknown origin is not the user's: its card expires; a stopped turn's call is refused", async () => {
    const clock = clockAt();
    const b = new CloverApprovalBroker({ clock });
    let card: Card | undefined;
    b.watch((e) => { if (e.type === "requested") card = e.card; });
    const pending = call(b, "Bash", { command: "make" });
    await Bun.sleep(0);
    expect(card?.expiresAt).not.toBeNull();
    clock.advance(10 * 60 * 1000);
    expect(await pending).toEqual({ behavior: "deny", message: "Bash was refused: no one answered its card in time." });
    const ac = new AbortController();
    const stopped = call(b, "Bash", { command: "make" }, "user", ac.signal);
    await Bun.sleep(0);
    ac.abort();
    expect(await stopped).toEqual({ behavior: "deny", message: "Bash was refused: the turn was stopped." });
  });
});
