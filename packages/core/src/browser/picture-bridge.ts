// The Browser tool's live picture (spec revision 19, §3.6, G5, the first publisher): the tab the tool drives, shown to
// whoever reads the session's pictures.
//
// The tool is the bundled Browser plugin, whose `browser` server declares `picture: true`. The picture is the ENGINE's to
// publish, from the tool's own call: when the tool drives a tab (its `browser.open`, `navigate`, `screenshot` or `cdp`),
// the bridge keys a picture to that call's session (`toolCallOf`: the core's record of the call, never the plugin's word)
// and passes on the tab's frames. The tool plugin writes none (its `browser.*` calls are refused once its call has ended;
// the picture outlives the call, until the tab closes or its session ends).
//
// The frames come from a `TabFrames` (lane HS's small internal interface over the host's `host.tab.frame` notifications
// from the Electron process): subscribe to a tab, get the latest frame and each later one. This lane adds no path from the
// app to the engine of its own; until the host's source is given, no frames arrive and no picture is made.
import type { PicturePublishMeta } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "../contracts/common";
import type { ApiCallContext } from "../plugin-host/api/router";
import { toolCallOf, type PictureSessions } from "../pictures/api";
import type { EngineLivePictures } from "../pictures/live-pictures";

export interface TabFrame {
  format: PicturePublishMeta["format"];
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** A tab's frames, as the host gives them. `onEnd` hears the tab close or the source go. */
export interface TabFrames {
  subscribe(tabId: string, fn: (frame: TabFrame) => void, onEnd?: () => void): Unsubscribe;
}

export interface BrowserPicturesOptions {
  pictures: EngineLivePictures;
  sessions: PictureSessions;
  frames: TabFrames | undefined;
}

/** What the browser handlers call when the tool drives a tab. Never throws: a picture is a view, never a reason for a tool call to fail. */
export type BrowserPictureBridge = ((ctx: ApiCallContext, tabId: string) => void) & {
  /** A session ended: the tab subscriptions made for it are let go, so a later frame never makes a picture for it. */
  sessionEnded(session: string): void;
};

export function browserPictureBridge(o: BrowserPicturesOptions): BrowserPictureBridge {
  const live = new Map<string, { session: string; stop: Unsubscribe }>();
  const drives = (ctx: ApiCallContext, tabId: string): void => {
    if (o.frames === undefined) return;
    try {
      const call = toolCallOf(ctx, o.sessions);
      if (!call.declares) return;
      const key = `${call.session}\u0000${call.pluginId}\u0000${tabId}`;
      if (live.has(key)) return;
      let publisher: ReturnType<EngineLivePictures["publish"]> | undefined;
      let shape = "";
      const stop = o.frames.subscribe(tabId, (frame) => {
        const now = `${frame.format}:${frame.width}x${frame.height}`;
        if (publisher === undefined || shape !== now) {
          publisher?.end();
          try {
            // The first frame names the picture's size; a tab that is resized makes a new picture (the old one ends).
            publisher = o.pictures.publish({ ...call, open: true }, { format: frame.format, width: frame.width, height: frame.height });
          } catch {
            publisher = undefined;
            return;
          }
          shape = now;
        }
        publisher.frame(frame.bytes);
      }, () => {
        live.delete(key);
        publisher?.end();
        publisher = undefined;
      });
      live.set(key, {
        session: call.session,
        stop: () => {
          stop();
          publisher?.end();
        },
      });
    } catch {
      // not a tool call a session made, or its server doesn't declare a picture: the tool goes on without one
    }
  };
  return Object.assign(drives, {
    sessionEnded(session: string): void {
      for (const [key, entry] of [...live]) {
        if (entry.session !== session) continue;
        live.delete(key);
        try { entry.stop(); } catch { /* already let go */ }
      }
    },
  });
}
