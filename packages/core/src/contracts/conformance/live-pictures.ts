// The LivePictures conformance suite (spec revision 19, §3.6, G5). `runLivePicturesConformance(make)` registers every case
// against the implementation `make` builds; `tests/live-pictures.test.ts` runs it against FakeLivePictures, and lane AF
// runs it against the engine's. What it pins: a picture keyed to the tool call's session and never to the publisher's
// word, the manifest's declaration and the open call, inert pixels, one picture per session and publisher, readers by
// kind, and the ends.
import { describe, expect, test } from "bun:test";
import { PICTURE_FRAME_MAX_BYTES, type PicturePublishMeta } from "@waifucave/moss-protocol";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import type { FakeLivePictures } from "../fakes/live-pictures";
import type { PictureEvent, ToolCallContext } from "../live-pictures";

export type LivePicturesHarness = Pick<FakeLivePictures, keyof FakeLivePictures>;
export type LivePicturesFactory = (...args: ConstructorParameters<typeof FakeLivePictures>) => LivePicturesHarness;

const call = (extra: Partial<ToolCallContext> = {}): ToolCallContext => ({ session: "s_alpha", kind: "bots", bot: "alpha", pluginId: "acme-cu", tool: "mcp__acme__Click", callId: "call_1", declares: true, open: true, ...extra });
const meta: PicturePublishMeta = { format: "jpeg", width: 1280, height: 800 };
/** A JPEG that is only a header: SOI, then a start-of-frame marker with the size, padded to `n` bytes. */
const jpeg = (n = 32, width = 1280, height = 800) => {
  const b = new Uint8Array(Math.max(n, 24));
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return b;
};
const user = { kind: "user" as const };
const thrown = (f: () => unknown) => { try { f(); } catch (e) { return e; } return undefined; };

export function runLivePicturesConformance(make: LivePicturesFactory): void {
  const setup = () => make({ clock: new FakeClock() });

  describe("LivePictures", () => {
    test("a picture belongs to the tool call's session, with the engine's id and the publisher's plugin id", () => {
      const pics = setup();
      const p = pics.publish(call(), meta);
      expect(p.id).toMatch(/^pic_[A-Za-z0-9_-]{6,58}$/);
      expect(pics.list("bots", user)).toEqual([expect.objectContaining({ id: p.id, session: "s_alpha", bot: "alpha", publisher: "acme-cu", kind: "bots", format: "jpeg", screen: false })]);
      // The publisher can't name a session, an id or anything else in its meta.
      for (const extra of [{ session: "s_other" }, { id: "pic_mine01" }, { html: "<b>hi</b>" }]) {
        expect(isContractError(thrown(() => pics.publish(call(), { ...meta, ...extra } as PicturePublishMeta)), "invalid")).toBe(true);
      }
      expect(pics.list("bots", user).length).toBe(1);
    });

    test("only a server that declares a picture, only while the call runs", () => {
      const pics = setup();
      expect(isContractError(thrown(() => pics.publish(call({ declares: false }), meta)), "refused")).toBe(true);
      expect(isContractError(thrown(() => pics.publish(call({ open: false }), meta)), "refused")).toBe(true);
    });

    test("frames are whole images of the declared format; the latest is kept; anything else ends the picture", () => {
      const pics = setup();
      const events: PictureEvent[] = [];
      pics.watch("bots", user, (e) => events.push(e));
      const p = pics.publish(call(), meta);
      const r = pics.open(p.id, user);
      const got: number[] = [];
      r.onFrame((b) => got.push(b.length));
      p.frame(jpeg(40));
      p.frame(jpeg(48));
      expect(r.latest()?.length).toBe(48);
      expect(got).toEqual([40, 48]);
      p.frame(new TextEncoder().encode("<svg onload=alert(1)>"));
      expect(events.at(-1)).toEqual({ ended: p.id, why: "publisher" });
      expect(r.latest()).toBeUndefined();
      const big = pics.publish(call(), meta);
      big.frame(jpeg(PICTURE_FRAME_MAX_BYTES + 1));
      expect(events.at(-1)).toEqual({ ended: big.id, why: "too-large" });
    });

    test("a frame whose own header claims more pixels than the picture declared, or no readable size, ends it", () => {
      const pics = setup();
      const events: PictureEvent[] = [];
      pics.watch("bots", user, (e) => events.push(e));
      const bomb = pics.publish(call(), meta);
      bomb.frame(jpeg(64, 60000, 60000));
      expect(events.at(-1)).toEqual({ ended: bomb.id, why: "publisher" });
      const bare = pics.publish(call(), meta);
      const magicOnly = new Uint8Array(32);
      magicOnly.set([0xff, 0xd8, 0xff]);
      bare.frame(magicOnly);
      expect(events.at(-1)).toEqual({ ended: bare.id, why: "publisher" });
      const smaller = pics.publish(call(), meta);
      smaller.frame(jpeg(64, 640, 400));
      expect(pics.list("bots", user).map((v) => v.id)).toEqual([smaller.id]);
    });

    test("a picture outlives its call unless its publisher tied it to the call", () => {
      const pics = setup();
      const ends: PictureEvent[] = [];
      pics.watch("bots", user, (e) => { if ("ended" in e) ends.push(e); });
      const stays = pics.publish(call({ callId: "call_a" }), meta);
      const tied = pics.publish(call({ callId: "call_b", pluginId: "tied-cu" }), { ...meta, endsWithCall: true });
      pics.callEnded("call_a");
      pics.callEnded("call_b");
      expect(ends).toEqual([{ ended: tied.id, why: "call-ended" }]);
      expect(pics.list("bots", user).map((v) => v.id)).toEqual([stays.id]);
    });

    test("one picture per session and publisher: a second replaces the first", () => {
      const pics = setup();
      const a = pics.publish(call(), meta);
      const b = pics.publish(call({ callId: "call_2" }), { ...meta, format: "png" });
      const other = pics.publish(call({ pluginId: "moss/browser" }), meta);
      expect(pics.list("bots", user).map((v) => v.id).sort()).toEqual([b.id, other.id].sort());
      a.frame(jpeg());
      expect(pics.list("bots", user).find((v) => v.id === a.id)).toBeUndefined();
    });

    test("readers by kind: a plugin needs the kind's picture.read; a watch never hears the other kind", () => {
      const pics = setup();
      const codeOnly = { kind: "plugin" as const, capabilities: ["picture.read.sessions"] };
      const heard: PictureEvent[] = [];
      pics.watch("sessions", codeOnly, (e) => heard.push(e));
      const botPic = pics.publish(call(), meta);
      const codePic = pics.publish(call({ session: "s_code1", kind: "sessions", bot: undefined }), meta);
      expect(heard.map((e) => ("picture" in e ? e.picture.id : e.ended))).toEqual([codePic.id]);
      expect(isContractError(thrown(() => pics.list("bots", codeOnly)), "refused")).toBe(true);
      expect(isContractError(thrown(() => pics.open(botPic.id, codeOnly)), "refused")).toBe(true);
      expect(pics.open(codePic.id, codeOnly).latest()).toBeUndefined();
      expect(isContractError(thrown(() => pics.open("pic_nothere", user)), "not_found")).toBe(true);
    });

    test("a picture ends with its session or its plugin", () => {
      const pics = setup();
      const ends: PictureEvent[] = [];
      pics.watch("bots", user, (e) => { if ("ended" in e) ends.push(e); });
      const a = pics.publish(call(), meta);
      const b = pics.publish(call({ session: "s_alpha2", pluginId: "other-cu" }), meta);
      pics.sessionEnded("s_alpha");
      pics.pluginStopped("other-cu");
      expect(ends).toEqual([{ ended: a.id, why: "session" }, { ended: b.id, why: "plugin-stopped" }]);
      expect(pics.list("bots", user)).toEqual([]);
    });
  });
}
