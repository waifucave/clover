// FakeLivePictures: live pictures in memory, keyed to the tool call's session, with inert-pixel checks and readers by kind.
import { PICTURE_FRAME_MAX_BYTES, PicturePublishMeta, type DataKind, type PictureView } from "@waifucave/moss-protocol";
import { randomBytes } from "node:crypto";
import type { Clock } from "../clock";
import { readerMay, type FeedReader } from "../activity-feed";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import { frameVerdict, type LivePictures, type PictureEndWhy, type PictureEvent, type PicturePublisher, type PictureReader, type ToolCallContext } from "../live-pictures";

interface Held {
  view: PictureView;
  latest: Uint8Array | undefined;
  frames: Listeners<Uint8Array>;
  meta: PicturePublishMeta;
  callId: string;
  endsWithCall: boolean;
}

export class FakeLivePictures implements LivePictures {
  readonly #clock: Clock;
  readonly #pictures = new Map<string, Held>();
  readonly #events: Record<DataKind, Listeners<PictureEvent>> = { sessions: new Listeners(), bots: new Listeners() };

  constructor(opts: { clock: Clock }) {
    this.#clock = opts.clock;
  }

  #end(id: string, why: PictureEndWhy): void {
    const held = this.#pictures.get(id);
    if (!held) return;
    this.#pictures.delete(id);
    this.#events[held.view.kind].emit({ ended: id, why });
  }

  publish(call: ToolCallContext, meta: PicturePublishMeta): PicturePublisher {
    if (!call.declares) throw new ContractError("refused", "its server doesn't declare a live picture (picture: true)");
    if (!call.open) throw new ContractError("refused", "a picture is published only while the tool call it serves runs");
    const parsed = PicturePublishMeta.safeParse(meta);
    if (!parsed.success) throw new ContractError("invalid", "a picture's meta is its format and size only");
    for (const [id, h] of this.#pictures) if (h.view.session === call.session && h.view.publisher === call.pluginId) this.#end(id, "publisher");
    const id = `pic_${randomBytes(9).toString("base64url")}`;
    const view: PictureView = {
      id, kind: call.kind, session: call.session, ...(call.bot !== undefined ? { bot: call.bot } : {}), publisher: call.pluginId, tool: call.tool,
      format: parsed.data.format, width: parsed.data.width, height: parsed.data.height, screen: parsed.data.screen ?? false, startedAt: this.#clock.now(),
    };
    const held: Held = { view, latest: undefined, frames: new Listeners(), meta: parsed.data, callId: call.callId, endsWithCall: parsed.data.endsWithCall === true };
    this.#pictures.set(id, held);
    this.#events[view.kind].emit({ picture: view });
    return {
      id,
      frame: (bytes) => {
        if (this.#pictures.get(id) !== held) return;
        const verdict = frameVerdict(held.meta, bytes, PICTURE_FRAME_MAX_BYTES);
        if (verdict === "too-large") return this.#end(id, "too-large");
        if (verdict !== "ok") return this.#end(id, "publisher");
        held.latest = bytes;
        held.frames.emit(bytes);
      },
      end: () => this.#end(id, "publisher"),
    };
  }

  #check(kind: DataKind, reader: FeedReader): void {
    if (!readerMay(reader, "picture.read.*", kind)) throw new ContractError("refused", `showing ${kind}' live pictures needs picture.read.${kind}`);
  }

  list(kind: DataKind, reader: FeedReader, of: { session?: string; bot?: string } = {}): PictureView[] {
    this.#check(kind, reader);
    return [...this.#pictures.values()].map((h) => h.view).filter((v) => v.kind === kind && (of.session === undefined || v.session === of.session) && (of.bot === undefined || v.bot === of.bot));
  }

  open(id: string, reader: FeedReader): PictureReader {
    const held = this.#pictures.get(id);
    if (!held) throw new ContractError("not_found", "no such live picture");
    this.#check(held.view.kind, reader);
    const subs = new Set<Unsubscribe>();
    return {
      latest: () => (this.#pictures.get(id) === held ? held.latest : undefined),
      onFrame: (fn) => { const u = held.frames.add(fn); subs.add(u); return u; },
      close: () => { for (const u of subs) u(); subs.clear(); },
    };
  }

  sessionEnded(session: string): void {
    for (const [id, h] of [...this.#pictures]) if (h.view.session === session) this.#end(id, "session");
  }

  callEnded(callId: string): void {
    for (const [id, h] of [...this.#pictures]) if (h.endsWithCall && h.callId === callId) this.#end(id, "call-ended");
  }

  pluginStopped(pluginId: string): void {
    for (const [id, h] of [...this.#pictures]) if (h.view.publisher === pluginId) this.#end(id, "plugin-stopped");
  }

  watch(kind: DataKind, reader: FeedReader, fn: (event: PictureEvent) => void): Unsubscribe {
    this.#check(kind, reader);
    return this.#events[kind].add(fn);
  }
}
