// The engine's live pictures (spec revision 19, §3.6 "A tool's live picture", G5; contract `contracts/live-pictures.ts`).
// A tool plugin whose server declares `picture: true` publishes a picture of its work for the session of the tool call it
// serves; the engine keys it to that call's session (`ToolCallContext`, read from the plugin host's own record of the call,
// never from anything the publisher names), gives it its own id, and shows it to readers by kind.
//
// * A frame is one whole image in the declared format, checked by its magic bytes and its own header's size
//   (`frameVerdict`): an image that claims more pixels than the picture declared, or isn't one, ends the picture, so a
//   window or a plugin is never asked to decode a bomb.
// * Readers get the latest frame: a reader's callback runs on each frame and a slow reader's transport drops what it can't
//   take (`pictures/transport.ts`); nothing here queues.
// * It ends when its publisher ends it or goes (`PicturePublisher.end`: the stream's end or abort), when its session ends
//   (`sessionEnded`), when its plugin stops (`pluginStopped`), when a frame is bad (`too-large`, or `publisher`), and, when
//   the publisher tied it to its call (`endsWithCall`), when that call ends (`callEnded`).
import { PICTURE_FRAME_MAX_BYTES, PicturePublishMeta, type DataKind, type PictureView } from "@waifucave/moss-protocol";
import { randomBytes } from "node:crypto";
import type { Clock } from "../contracts/clock";
import { readerMay, type FeedReader } from "../contracts/activity-feed";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import { frameVerdict, type LivePictures, type PictureEndWhy, type PictureEvent, type PicturePublisher, type PictureReader, type ToolCallContext } from "../contracts/live-pictures";

interface Held {
  view: PictureView;
  meta: PicturePublishMeta;
  latest: Uint8Array | undefined;
  frames: Listeners<Uint8Array>;
  callId: string;
  endsWithCall: boolean;
}

/** How many pictures one plugin may have up at once, across its sessions. */
export const PICTURES_PER_PLUGIN = 16;

export interface EngineLivePicturesOptions {
  clock: Pick<Clock, "now">;
  log?(line: string): void;
}

export class EngineLivePictures implements LivePictures {
  readonly #o: EngineLivePicturesOptions;
  readonly #pictures = new Map<string, Held>();
  readonly #events: Record<DataKind, Listeners<PictureEvent>> = { sessions: new Listeners(), bots: new Listeners() };

  constructor(opts: EngineLivePicturesOptions) {
    this.#o = opts;
  }

  #end(id: string, why: PictureEndWhy): void {
    const held = this.#pictures.get(id);
    if (!held) return;
    this.#pictures.delete(id);
    // One line per picture ended, with why and never what it showed.
    this.#o.log?.(`pictures: ${held.view.publisher}'s picture (${id.slice(4, 12)}) of ${held.view.kind} ended (${why})`);
    this.#events[held.view.kind].emit({ ended: id, why });
  }

  publish(call: ToolCallContext, meta: PicturePublishMeta): PicturePublisher {
    if (!call.declares) throw new ContractError("refused", "its server doesn't declare a live picture (picture: true)");
    if (!call.open) throw new ContractError("refused", "a picture is published only while the tool call it serves runs");
    const parsed = PicturePublishMeta.safeParse(meta);
    if (!parsed.success) throw new ContractError("invalid", "a picture's meta is its format and size only");
    // One picture per session and publisher: a second replaces the first.
    for (const [id, h] of [...this.#pictures]) if (h.view.session === call.session && h.view.publisher === call.pluginId) this.#end(id, "publisher");
    let mine = 0;
    for (const h of this.#pictures.values()) if (h.view.publisher === call.pluginId) mine++;
    if (mine >= PICTURES_PER_PLUGIN) throw new ContractError("refused", `${call.pluginId} has ${PICTURES_PER_PLUGIN} live pictures up, the most a plugin may; end one first`);
    const id = `pic_${randomBytes(9).toString("base64url")}`;
    const view: PictureView = {
      id, kind: call.kind, session: call.session, ...(call.bot !== undefined ? { bot: call.bot } : {}), publisher: call.pluginId,
      ...(/^[A-Za-z0-9_.-]{1,128}$/.test(call.tool) ? { tool: call.tool } : {}),
      format: parsed.data.format, width: parsed.data.width, height: parsed.data.height, screen: parsed.data.screen ?? false, startedAt: this.#o.clock.now(),
    };
    const held: Held = { view, meta: parsed.data, latest: undefined, frames: new Listeners(), callId: call.callId, endsWithCall: parsed.data.endsWithCall === true };
    this.#pictures.set(id, held);
    this.#o.log?.(`pictures: ${call.pluginId}'s picture (${id.slice(4, 12)}) of ${view.kind} opened`);
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

  /** The picture `id`'s view, or undefined. */
  view(id: string): PictureView | undefined {
    return this.#pictures.get(id)?.view;
  }

  /** The kind of picture `id` is, for a gate that must name the kind before it opens one; undefined when there is none. */
  kindOf(id: string): DataKind | undefined {
    return this.#pictures.get(id)?.view.kind;
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

  pluginStopped(pluginId: string): void {
    for (const [id, h] of [...this.#pictures]) if (h.view.publisher === pluginId) this.#end(id, "plugin-stopped");
  }

  /** The engine ends a picture itself, for a reason it found in the publisher's stream (a frame announced bigger than the
   *  most there is, or a frame that isn't an image). Not the publisher's own call. */
  endWith(id: string, why: PictureEndWhy): void {
    this.#end(id, why);
  }

  callEnded(callId: string): void {
    for (const [id, h] of [...this.#pictures]) if (h.endsWithCall && h.callId === callId) this.#end(id, "call-ended");
  }

  watch(kind: DataKind, reader: FeedReader, fn: (event: PictureEvent) => void): Unsubscribe {
    this.#check(kind, reader);
    return this.#events[kind].add(fn);
  }

  /** Pictures up now, for tests and status. */
  get size(): number {
    return this.#pictures.size;
  }
}
