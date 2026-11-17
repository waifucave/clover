// A fake engine for MOSS's tests and renders: the real wire (JSON-RPC over NDJSON on `<home>/run/core.sock`, the `app`
// token, `protocol.prove`, the hello with `surface`), with the pieces other lanes are building served from the spine's
// contracts' own fakes (`@waifucave/moss-core/contracts/fakes`): bots as records (FakeBotRecords), the activity feed
// (FakeActivityFeed), live pictures (FakeLivePictures), the router (FakeCardRouter, fed by MOSS's presence reports), the
// program answer keys (FakeProgramAnswerKeys, a real Ed25519 check of MOSS's registration and of every answer) and the
// tool setting (FakeToolSettings). A method it doesn't serve answers as the real engine does: "not served yet" (-32601).
//
// It never touches a real home: the tests give it a temp folder. Everything it is asked goes to `<home>/fake/calls.jsonl`.
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  encodeLine, LineDecoder, programCardAnswerSigningInput, SURFACE_MOUNTS, MOSS_ERR,
  type ActivityState, type Card, type CardPlacement, type Surface,
} from "@waifucave/moss-protocol";
import { FakeActivityFeed, FakeBotRecords, FakeCardRouter, FakeLivePictures, FakeProgramAnswerKeys, FakeToolSettings } from "@waifucave/moss-core/contracts/fakes";
import type { Clock, TimerHandle } from "@waifucave/moss-core/contracts";
import { daemonEndpoint } from "../../src/main/client";
import { BOTS, botId, cardsAt, MODELS, PLUGINS, routinesOf, TOOL_VALUES } from "./fixtures";

export const FAKE_DEVICE = "devstudio0000000001";

/** Real time, for the fakes that take a clock. */
export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return { id: t as unknown as number, t } as unknown as TimerHandle;
  },
  clearTimeout: (h) => clearTimeout((h as unknown as { t: ReturnType<typeof setTimeout> }).t),
  status: () => ({ reference: "public", offsetMs: 0, accuracyMs: 0, synced: true }),
};

export type FakePiece = "bots" | "activity" | "router" | "pictures" | "routines" | "tools" | "keys";

export interface FakeEngineOptions {
  home: string;
  /** Pieces this engine doesn't serve (their methods answer "not served yet"). */
  drop?: readonly FakePiece[];
  /** The engine's release; a hello naming another is refused as behind. Default: the hello's own. */
  release?: string;
  /** A PNG for the live picture's frames; none: no picture. */
  picturePng?: Uint8Array;
  /** How often a followed picture sends a frame. */
  frameMs?: number;
  /** The pid `protocol.prove` says it sees at the other end: MOSS's (the test knows it; a Unix socket's peer pid isn't
   *  read here). Default: this process's, for a client in the same process. */
  peerPid?: () => number | undefined;
}

interface Conn {
  id: number;
  socket: Socket;
  authed: boolean;
  surface?: Surface;
  areas: Set<string>;
  attached: Set<string>;
  streams: Map<string, ReturnType<typeof setInterval>>;
}

type Rpc = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export interface FakeEngine {
  home: string;
  token: string;
  endpoint: string;
  bots: FakeBotRecords;
  feed: FakeActivityFeed;
  router: FakeCardRouter;
  keys: FakeProgramAnswerKeys;
  /** Every request MOSS made, in order (method and params, the token left out). */
  calls(): { method: string; params: unknown; conn: number }[];
  /** The cards answered, and with which option. */
  answered(): { id: string; option: string; program: string }[];
  placements(): { card: string; place: CardPlacement }[];
  /** Asks every app connection a request of the engine's own (`app.ping`, `app.quit`). */
  ask(method: string, params?: unknown): Promise<unknown[]>;
  close(): Promise<void>;
}

export async function startFakeEngine(o: FakeEngineOptions): Promise<FakeEngine> {
  const drop = new Set(o.drop ?? []);
  const run = join(o.home, "run");
  mkdirSync(run, { recursive: true });
  mkdirSync(join(o.home, "fake"), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(join(run, "app.token"), token, { mode: 0o600 });
  const endpoint = daemonEndpoint(o.home);
  rmSync(endpoint, { force: true });
  const log: { method: string; params: unknown; conn: number }[] = [];
  const answered: { id: string; option: string; program: string }[] = [];

  const now = Date.now();
  const bots = new FakeBotRecords({ clock: realClock });
  const feed = new FakeActivityFeed();
  const pictures = new FakeLivePictures({ clock: realClock });
  const router = new FakeCardRouter({ clock: realClock, hostLive: true });
  const keys = new FakeProgramAnswerKeys();
  const tools = new FakeToolSettings();
  for (const p of PLUGINS) tools.declare(p.server, { ...p.tools } as Record<string, "preload" | "on-demand">);
  for (const v of TOOL_VALUES) {
    if (v.availability !== undefined) tools.setAvailability(v.server, v.tool, v.availability);
    if (v.permission !== undefined) tools.setPermission(v.server, v.tool, v.permission);
  }

  /** Each bot's conversation, as its main session's events. */
  const talk = new Map<string, Record<string, unknown>[]>();
  const summaries = new Map<string, { id: string; last?: { text: string; from: "user" | "bot" | "note"; at: number }; unread: boolean }>();
  for (const b of BOTS) {
    const v = await bots.create({ name: b.name, ...(b.face !== undefined ? { face: b.face } : {}), ...(b.model !== undefined ? { model: b.model } : {}), ...(b.instructions !== undefined ? { instructions: b.instructions } : {}) }, { kind: "user" });
    const session = v.mainSession;
    const events: Record<string, unknown>[] = [];
    const start = now - b.ago * 60_000 - b.talk.length * 90_000;
    b.talk.forEach(([who, text, files], i) => {
      const ts = start + (i + 1) * 90_000;
      events.push(who === "user"
        ? { type: "user_message", seq: i + 1, sessionId: session, ts, threadId: "main", text: files !== undefined ? `${text} [File #1]` : text, clientName: "MOSS", ...(files !== undefined ? { files: files.map((f, n) => ({ n: n + 1, path: `/Users/someone/Documents/${f}` })) } : {}) }
        : { type: "assistant_message", seq: i + 1, sessionId: session, ts, threadId: "main", text });
    });
    talk.set(v.id, events);
    const lastTalk = b.talk[b.talk.length - 1];
    summaries.set(v.id, { id: v.id, ...(lastTalk !== undefined ? { last: { text: lastTalk[1], from: lastTalk[0], at: now - b.ago * 60_000 } } : {}), unread: b.unread === true });
    feed.set({ subject: { kind: "bots", id: v.id }, state: b.mood, name: b.name, ...(b.tool !== undefined ? { tool: b.tool } : {}), since: now - b.ago * 60_000 });
  }
  // Juniper's browser publishes a live picture of its tab.
  let pictureId: string | undefined;
  if (o.picturePng !== undefined) {
    const pub = pictures.publish({ session: "bot:juniper", kind: "bots", bot: "juniper", pluginId: "moss/browser", tool: "mcp__moss__Browser", callId: "call_1", declares: true, open: true }, { format: "png", width: 1280, height: 800 });
    pub.frame(o.picturePng);
    pictureId = pub.id;
  }
  const cards = new Map<string, Card>(cardsAt(now).map((c) => [c.id, c]));
  for (const c of cards.values()) router.pending({ id: c.id, ...(c.session !== undefined ? { session: c.session } : {}), ...(c.bot !== undefined ? { bot: c.bot } : {}) });

  const conns = new Map<number, Conn>();
  let nextConn = 1;
  let nextReq = 1;
  const waiting = new Map<number, (v: unknown) => void>();

  const write = (c: Conn, msg: unknown) => { if (!c.socket.destroyed) c.socket.write(encodeLine(msg)); };
  const event = (area: string, e: Record<string, unknown>) => {
    for (const c of conns.values()) if (c.authed && c.areas.has(area)) write(c, { jsonrpc: "2.0", method: "core.event", params: { ts: Date.now(), ...e } });
  };
  router.watch((ch) => event("surfaces", { type: "card_placed", card: ch.card, place: ch.place, ...(ch.before !== undefined ? { before: ch.before } : {}) }));
  feed.watch("bots", { kind: "user" }, (a) => event("activity", { type: "activity_changed", activity: a }));

  const notServed = (method: string) => new RpcError(-32601, `${method} is not served yet`);
  const piece = (p: FakePiece, method: string) => { if (drop.has(p)) throw notServed(method); };

  async function serve(c: Conn, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "protocol.prove") {
      const nonce = String(params.nonce ?? "");
      const pid = o.peerPid?.() ?? process.pid;
      return { proof: createHmac("sha256", token).update(`moss-daemon-proof\0${nonce}\0${pid}`).digest("base64url"), pid };
    }
    if (method === "protocol.hello") {
      if (params.token !== token) throw new RpcError(-32001, "bad token");
      const surface = (params.surface ?? "code") as Surface;
      if (params.role !== "app") throw new RpcError(MOSS_ERR.SURFACE_REFUSED, "surface refused", { reason: "not-app", surface });
      const release = typeof params.release === "string" ? params.release : undefined;
      if (o.release !== undefined && release !== undefined && release !== o.release) throw new RpcError(MOSS_ERR.RELEASE_REFUSED, "release refused", { standing: "behind", engine: o.release, client: release, needs: o.release });
      c.authed = true;
      c.surface = surface;
      return {
        ok: true, serverVersion: "0.124.0", protocolVersion: 1, caller: { kind: "user", client: "app" }, device: FAKE_DEVICE, features: [],
        surface, mount: SURFACE_MOUNTS[surface], ...(release !== undefined ? { release: { standing: "same", engine: o.release ?? release } } : {}),
      };
    }
    if (!c.authed) throw new RpcError(-32002, "say hello first");
    switch (method) {
      case "events.subscribe":
        for (const a of (params.areas as string[]) ?? []) c.areas.add(a);
        return { ok: true };
      case "bot.records":
        piece("bots", method);
        return { bots: bots.list() };
      case "bot.summaries":
        piece("bots", method);
        return { summaries: [...summaries.values()] };
      case "bot.conversation": {
        piece("bots", method);
        const id = String(params.id);
        const v = bots.get(id);
        if (v === undefined) throw new RpcError(-32004, `no bot ${id}`);
        return { session: v.mainSession, events: talk.get(id) ?? [], hasMore: false };
      }
      case "bot.create": {
        piece("bots", method);
        const v = await bots.create({ name: String(params.name) }, { kind: "user" });
        talk.set(v.id, []);
        summaries.set(v.id, { id: v.id, unread: false });
        feed.set({ subject: { kind: "bots", id: v.id }, state: "idle", name: String(params.name), since: Date.now() });
        event("bots", { type: "bot_record_changed", bot: v });
        return { bot: v };
      }
      case "bot.markRead": {
        piece("bots", method);
        const s = summaries.get(String(params.id));
        if (s !== undefined) s.unread = false;
        return { ok: true };
      }
      case "activity.list":
        piece("activity", method);
        return { activity: feed.list("bots", { kind: "user" }) };
      case "routine.list":
        piece("routines", method);
        return { routines: routinesOf(String(params.bot ?? ""), now) };
      case "picture.list":
        piece("pictures", method);
        return { pictures: pictures.list("bots", { kind: "user" }, typeof params.bot === "string" ? { bot: params.bot } : {}) };
      case "picture.open": {
        piece("pictures", method);
        const id = String(params.id);
        const reader = pictures.open(id, { kind: "user" });
        const stream = `st_${randomBytes(6).toString("hex")}`;
        let seq = 0;
        const send = () => {
          const bytes = reader.latest();
          if (bytes !== undefined) write(c, { jsonrpc: "2.0", method: "picture.frame", params: { stream, seq: seq++, format: "png", width: 1280, height: 800, data: Buffer.from(bytes).toString("base64"), at: Date.now() } });
        };
        setTimeout(send, 50);
        c.streams.set(stream, setInterval(send, o.frameMs ?? 1_000));
        return { stream };
      }
      case "picture.close": {
        const t = c.streams.get(String(params.stream));
        if (t !== undefined) clearInterval(t);
        c.streams.delete(String(params.stream));
        return { ok: true };
      }
      case "card.list":
        return { cards: [...cards.values()] };
      case "card.placement":
        piece("router", method);
        return { placements: router.list() };
      case "presence.report":
        piece("router", method);
        if (c.surface !== "moss" && c.surface !== "code") throw new RpcError(MOSS_ERR.SURFACE_REFUSED, "only a window reports presence");
        return router.report({ connId: c.id, program: c.surface }, params as never);
      case "device.programKey.set": {
        piece("keys", method);
        try {
          return await keys.register({ device: FAKE_DEVICE, program: c.surface ?? "code", publicKey: String(params.publicKey), held: params.held as never, alg: params.alg as never, signature: String(params.signature) });
        } catch (err) {
          throw new RpcError(-32602, err instanceof Error ? err.message : "invalid");
        }
      }
      case "card.answer": {
        const card = cards.get(String(params.id));
        if (card === undefined) return { accepted: false, reason: "no such card" };
        if (params.hash !== card.hash) return { accepted: false, reason: "the card changed" };
        const option = String(params.option);
        if (!card.options.some((x) => x.id === option)) return { accepted: false, reason: "no such option" };
        const proof = params.proof as { via?: string; device?: string; at?: number; signature?: string };
        const program = c.surface ?? "code";
        if (proof?.via !== "device" || proof.device !== FAKE_DEVICE || typeof proof.at !== "number" || typeof proof.signature !== "string") return { accepted: false, reason: "no device proof" };
        const input = programCardAnswerSigningInput({ program, id: card.id, hash: card.hash, option, at: proof.at, ...(Array.isArray(params.children) ? { children: params.children as string[] } : {}) });
        const ok = await keys.verify(FAKE_DEVICE, program, new TextEncoder().encode(input), new Uint8Array(Buffer.from(proof.signature, "base64")));
        if (!ok) return { accepted: false, reason: "the signature isn't this program's" };
        if (!router.mayPress(card.id, { kind: "window", program: program === "host" ? "code" : program, window: "main" })) return { accepted: false, reason: "the card isn't placed there" };
        cards.delete(card.id);
        router.resolved(card.id);
        answered.push({ id: card.id, option, program });
        event("approvals", { type: "card_resolved", id: card.id, outcome: card.options.find((x) => x.id === option)?.kind === "approve" ? "approved" : "denied", option });
        return { accepted: true };
      }
      case "computer.acting":
        return { running: false };
      case "release.record":
        return { ok: true };
      case "command.run":
        return { result: null };
      case "user.send": {
        const to = params.to as { bot?: string };
        const id = to?.bot;
        const v = id !== undefined ? bots.get(id) : undefined;
        if (v === undefined) throw new RpcError(-32004, "no such bot");
        const events = talk.get(v.id) ?? [];
        const e = { type: "user_message", seq: events.length + 1, sessionId: v.mainSession, ts: Date.now(), threadId: "main", text: String(params.text), clientName: "MOSS" };
        events.push(e);
        talk.set(v.id, events);
        for (const k of conns.values()) if (k.attached.has(v.mainSession)) write(k, { jsonrpc: "2.0", method: "event", params: e });
        return { seq: e.seq };
      }
      case "session.attach":
        c.attached.add(String(params.id));
        return { lastSeq: 0 };
      case "session.detach":
        c.attached.delete(String(params.id));
        return { ok: true };
      case "plugin.list":
        return { plugins: PLUGINS.map((p) => ({ id: p.id, name: p.name, version: "1.0.0", enabled: p.enabled, state: "running" })) };
      case "tool.permissions": {
        piece("tools", method);
        const rows = tools.list();
        return {
          plugins: PLUGINS.filter((p) => Object.keys(p.tools).length > 0).map((p) => ({
            pluginId: p.id, name: p.name, server: p.server,
            tools: rows.filter((r) => r.server === p.server).map((r) => ({ name: r.tool, permission: r.permission, availability: r.availability, declared: r.declared, cardRules: [] })),
          })),
        };
      }
      case "tool.setAvailability":
        piece("tools", method);
        tools.setAvailability(String(params.server), typeof params.tool === "string" ? params.tool : undefined, params.availability as never);
        return { ok: true };
      case "tool.setPermission":
        piece("tools", method);
        tools.setPermission(String(params.server), typeof params.tool === "string" ? params.tool : undefined, params.permission as never);
        return { ok: true };
      case "plugin.auth.signIn":
        return { state: typeof params.key === "string" ? "signed-in" : "signed-out", ...(typeof params.key === "string" ? {} : { authorizeUrl: "https://example.test/authorize" }) };
      case "plugin.auth.signOut":
        return { applied: false, card: "card_signout_000001" };
      case "bot.edit": {
        piece("bots", method);
        const v = await bots.edit(String(params.id), params.patch as never);
        event("bots", { type: "bot_record_changed", bot: v });
        return { applied: true };
      }
      case "models.list":
        return { models: MODELS, default: "anthropic/claude-sonnet" };
      case "plugin.install":
        return { id: "added-plugin", state: "found", card: "card_added_plugin" };
      case "account.status":
        return { signedIn: true, provider: "email", user: { id: "u_1", name: "Sam", email: "sam@example.test" } };
      case "device.list":
        return { devices: [{ id: FAKE_DEVICE, name: "Studio", kind: "desktop" }, { id: "devphone000000000001", name: "Phone", kind: "phone" }] };
      case "computer.list":
        return { computers: [{ name: "Studio", level: "ask-risky" }, { name: "Laptop", level: "ask" }] };
      case "plugin.auth.list":
        if (params.id === "moss/model-anthropic") return { auth: [{ index: 0, method: "api-key", state: "signed-in" }] };
        if (params.id === "fish-audio") return { auth: [{ index: 0, method: "api-key", state: "signed-out" }] };
        return { auth: [] };
      case "plugin.settings.get":
        if (params.id === "moss/voice") {
          return { settings: [
            { key: "voice", type: "enum", title: "Voice", scope: "bot", required: false, options: [{ value: "fish:river", title: "River (Fish Audio)" }, { value: "fish:sol", title: "Sol (Fish Audio)" }], value: "fish:river", set: true },
            { key: "silent", type: "boolean", title: "No voice for this bot", scope: "bot", required: false, value: false, set: false },
            { key: "speakReplies", type: "boolean", title: "Speak replies", scope: "account", required: false, value: true, set: false },
          ] };
        }
        return { settings: [] };
      case "bot.pluginSettings":
        piece("bots", method);
        return { plugins: [{ pluginId: "moss/voice", name: "MOSS Voice", settings: [
          { key: "voice", type: "enum", title: "Voice", scope: "bot", required: false, options: [{ value: "fish:river", title: "River (Fish Audio)" }, { value: "fish:sol", title: "Sol (Fish Audio)" }], value: "fish:river", set: true },
          { key: "silent", type: "boolean", title: "No voice for this bot", scope: "bot", required: false, value: false, set: false },
        ] }] };
      case "plugin.settings.set":
        return { applied: true };
      default:
        throw notServed(method);
    }
  }

  const server: Server = createServer((socket) => {
    const c: Conn = { id: nextConn++, socket, authed: false, areas: new Set(), attached: new Set(), streams: new Map() };
    conns.set(c.id, c);
    const dec = new LineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of dec.push(chunk)) {
        let msg: Rpc;
        try { msg = JSON.parse(line) as Rpc; } catch { continue; }
        if (msg.method === undefined && typeof msg.id === "number") { waiting.get(msg.id)?.(msg.error ?? msg.result); waiting.delete(msg.id); continue; }
        if (msg.method === undefined) continue;
        const method = msg.method;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const { token: _t, ...shown } = params;
        log.push({ method, params: shown, conn: c.id });
        try { appendFileSync(join(o.home, "fake", "calls.jsonl"), `${JSON.stringify({ t: Date.now(), conn: c.id, method, params: shown })}\n`); } catch { /* the home went away */ }
        void serve(c, method, params).then(
          (result) => { if (msg.id !== undefined) write(c, { jsonrpc: "2.0", id: msg.id, result }); },
          (err: unknown) => {
            const e = err instanceof RpcError ? err : new RpcError(-32603, err instanceof Error ? err.message : String(err));
            if (msg.id !== undefined) write(c, { jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
          },
        );
      }
    });
    const gone = () => {
      for (const t of c.streams.values()) clearInterval(t);
      conns.delete(c.id);
      router.dropped(c.id);
    };
    socket.on("close", gone);
    socket.on("error", gone);
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  void pictureId;

  return {
    home: o.home, token, endpoint, bots, feed, router, keys,
    calls: () => [...log],
    answered: () => [...answered],
    placements: () => router.list(),
    ask: async (method, params = {}) => Promise.all([...conns.values()].filter((c) => c.authed).map((c) => new Promise((resolve) => {
      const id = nextReq++;
      waiting.set(id, resolve);
      write(c, { jsonrpc: "2.0", id, method, params });
    }))),
    close: () => new Promise<void>((resolve) => {
      for (const c of conns.values()) { for (const t of c.streams.values()) clearInterval(t); c.socket.destroy(); }
      server.close(() => resolve());
    }),
  };
}

/** A mood set in the fake feed, as the engine would on a bot's turn. */
export function setMood(e: FakeEngine, id: string, state: ActivityState, name: string): void {
  e.feed.set({ subject: { kind: "bots", id }, state, name, since: Date.now() });
}

export { botId };
