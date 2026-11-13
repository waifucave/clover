// The acceptance run's media page: the user's click opens a file with the app's picker (a token, a name and a size back,
// never a path), the video plays from the media URL (range requests answered by the app), a WebAssembly module from this
// folder runs, a click saves a file with the save picker, and what a layer can do is read off. Everything it learned is a
// data attribute on its root, which the run reads. TSX importing React and the UI SDK, no react in the folder.
import { useEffect, useRef, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

type Facts = Record<string, string>;

export function AcceptanceMediaMain() {
  const api = usePluginApi();
  const [facts, setFacts] = useState<Facts>({});
  const video = useRef<HTMLVideoElement>(null);
  const set = (k: string, v: string) => setFacts((f) => ({ ...f, [k]: v }));
  const fail = (k: string) => (e: unknown) => set(k, `refused: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160)}`);

  useEffect(() => {
    void (async () => {
      try {
        const mod = await WebAssembly.instantiateStreaming(fetch("/_p/acceptance-media/client/add.wasm"));
        set("wasm", `add(2,3)=${(mod.instance.exports as { add(a: number, b: number): number }).add(2, 3)}`);
      } catch (e) {
        set("wasm", `no: ${String(e)}`);
      }
      set("worker", await new Promise<string>((resolve) => {
        try {
          const w = new Worker(URL.createObjectURL(new Blob(["onmessage = (e) => postMessage(e.data * 2)"], { type: "text/javascript" })));
          w.onmessage = (e) => resolve(`x2=${e.data}`);
          w.onerror = () => resolve("no");
          w.postMessage(21);
          setTimeout(() => resolve("timeout"), 4000);
        } catch (e) {
          resolve(`no: ${String(e)}`);
        }
      }));
      set("webcodecs", typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "undefined" ? "no" : "yes");
      set("webgl", document.createElement("canvas").getContext("webgl2") ? "webgl2" : "no");
      set("sab", `${typeof SharedArrayBuffer}/isolated=${String(self.crossOriginIsolated)}`);
    })();
  }, []);

  // A file dropped on the page: its name and token (never a path), or why not (`files.onDrop`).
  useEffect(() => {
    const stop = (api.files as unknown as { onDrop(l: (grants: { name: string; token: string }[], refused?: string) => void): () => void }).onDrop((grants, refused) => {
      set("drop", refused !== undefined ? `refused: ${refused}` : grants.map((g) => `${g.name} ${/^grant:[0-9a-f-]{36}$/.test(g.token) ? "token" : "bad-token"}`).join(","));
    });
    return stop;
  }, []);

  const folder = async () => {
    const r = (await (api.files as unknown as { pickFolder(o?: unknown): Promise<{ cancelled: true } | { grants: { name: string; access: string; token: string }[] }> }).pickFolder({}));
    if ("cancelled" in r) return set("folder", "cancelled");
    const g = r.grants[0]!;
    set("folder", `${g.name} ${g.access} ${/^grant:[0-9a-f-]{36}$/.test(g.token) ? "token" : "bad-token"}`);
  };
  const open = async () => {
    const r = await api.files.pickOpen({ filters: [{ name: "Video", extensions: ["webm", "mp4"] }] });
    if ("cancelled" in r) return set("open", "cancelled");
    const g = r.grants[0]!;
    set("open", `${g.name} ${g.size} ${g.access} ${/^grant:[0-9a-f-]{36}$/.test(g.token) ? "token" : "bad-token"}`);
    // Its host half uses the token as the path of `files.stat` (the core resolves it for this plugin alone): the size, or why not.
    void api.host.call<{ size?: number | null; note?: string }>("statToken", { token: g.token }).then(
      (r) => set("host", r.note !== undefined ? `note: ${r.note}` : `size ${r.size}`),
      (e: unknown) => set("host", `refused: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160)}`),
    );
    const url = api.files.url(g.token);
    const part = await fetch(url, { headers: { Range: "bytes=0-9" } });
    set("range", `${part.status} ${part.headers.get("Content-Range")} ${(await part.arrayBuffer()).byteLength}`);
    set("past", String((await fetch(url, { headers: { Range: `bytes=${(g.size ?? 0) + 100}-` } })).status));
    const v = video.current!;
    v.onloadedmetadata = () => set("video", `${v.videoWidth}x${v.videoHeight} ${v.duration.toFixed(1)}s`);
    v.onerror = () => set("video", `error ${v.error?.code}`);
    v.src = url;
  };
  const save = async () => {
    const r = await api.files.pickSave({ suggestedName: "export.bin" });
    if ("cancelled" in r) return set("save", "cancelled");
    const g = r.grants[0]!;
    set("save", `${g.name} ${g.access} ${/^grant:/.test(g.token) ? "token" : "bad-token"}`);
  };
  const attrs = Object.fromEntries(Object.entries(facts).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div data-acceptance-media="main" style={{ minHeight: 120 }} onDragOver={(e) => e.preventDefault()} {...attrs}>
      <button data-acceptance-media-step="open" onClick={() => void open().catch(fail("open"))}>Open video</button>
      <button data-acceptance-media-step="folder" onClick={() => void folder().catch(fail("folder"))}>Pick a folder</button>
      <button data-acceptance-media-step="save" onClick={() => void save().catch(fail("save"))}>Save a file</button>
      <video ref={video} muted width={64} height={48} />
    </div>
  );
}

/** The sidebar app entry's component (the sidebar draws its button from the entry's title and icon). */
export function AcceptanceMediaBadge() {
  return <span data-acceptance-media="badge">•</span>;
}
