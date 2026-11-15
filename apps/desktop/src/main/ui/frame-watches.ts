// The watches each frame opened on its plugin's connection (`plugin.layer.watch`), so a frame that goes (its part
// removed, its document reloaded or put to sleep, its renderer gone) ends them: the connection is the plugin's and
// outlives any one frame, so without this a dead frame's watches (and a turn it took, §5.4 "Turns") stayed open until
// the plugin's last frame went.

export class FrameWatches {
  readonly #byMount = new Map<string, Map<string, string>>();

  /** A watch a frame's part opened: its id, on `pluginId`'s connection. */
  add(mount: string, pluginId: string, watch: string): void {
    let m = this.#byMount.get(mount);
    if (m === undefined) this.#byMount.set(mount, (m = new Map()));
    m.set(watch, pluginId);
  }

  /** The part ended one itself. */
  forget(mount: string, watch: string): void {
    const m = this.#byMount.get(mount);
    if (m === undefined) return;
    m.delete(watch);
    if (m.size === 0) this.#byMount.delete(mount);
  }

  /** The part's frame is gone: the watches it left open, to end. */
  gone(mount: string): { pluginId: string; watch: string }[] {
    const m = this.#byMount.get(mount);
    if (m === undefined) return [];
    this.#byMount.delete(mount);
    return [...m].map(([watch, pluginId]) => ({ pluginId, watch }));
  }

  /** Open watches, for tests. */
  get size(): number {
    let n = 0;
    for (const m of this.#byMount.values()) n += m.size;
    return n;
  }
}
