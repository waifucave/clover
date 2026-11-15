// A page that does what a video editor's page does with files, for the app's tests: every click of the user's is one step
// (open a file, then save one), the video plays from the media URL, a WebAssembly module from this folder runs, and what
// a layer can do (workers, WebCodecs, WebGL, SharedArrayBuffer) is read off and written into the page's text. It never
// holds a path: the picker hands it tokens.
import { jsx } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { usePluginApi, useSurface } from "@waifucave/clover-plugin-sdk/ui";

const note = (text) => text.replace(/[\n\r]+/g, " ");

async function probes() {
  const out = {};
  try {
    const mod = await WebAssembly.instantiateStreaming(fetch(new URL("add.wasm", import.meta.url)));
    out.wasm = `add(2,3)=${mod.instance.exports.add(2, 3)}`;
  } catch (err) {
    out.wasm = `no: ${err}`;
  }
  try {
    const worker = new Worker(URL.createObjectURL(new Blob(["onmessage = (e) => postMessage(e.data * 2)"], { type: "text/javascript" })));
    out.worker = await new Promise((resolve, reject) => { worker.onmessage = (e) => resolve(`x2=${e.data}`); worker.onerror = (e) => reject(new Error("worker error")); worker.postMessage(21); setTimeout(() => reject(new Error("timeout")), 4000); });
    worker.terminate();
  } catch (err) {
    out.worker = `no: ${err}`;
  }
  out.sab = `${typeof SharedArrayBuffer}/isolated=${String(self.crossOriginIsolated)}`;
  try {
    out.webcodecs = typeof VideoDecoder === "undefined" ? "no" : `${(await VideoDecoder.isConfigSupported({ codec: "vp8" })).supported ? "vp8" : "no-vp8"}`;
  } catch (err) {
    out.webcodecs = `no: ${err}`;
  }
  try {
    const c = document.createElement("canvas");
    out.webgl = c.getContext("webgl2") ? "webgl2" : c.getContext("webgl") ? "webgl1" : "no";
  } catch (err) {
    out.webgl = `no: ${err}`;
  }
  return out;
}

export function FixtureMedia() {
  const surface = useSurface();
  const api = usePluginApi();
  const [facts, setFacts] = useState({});
  const stage = useRef(0);
  const video = useRef(null);
  const set = (k, v) => setFacts((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    surface({ width: 360, height: 160, regions: [{ x: 0, y: 0, width: 360, height: 160 }], visible: true });
    void probes().then((p) => setFacts((f) => ({ ...f, ...p })));
    // A page takes drops by cancelling dragover; what it gets of a drop is tokens, like a pick's.
    const over = (e) => e.preventDefault();
    window.addEventListener("dragover", over);
    const off = api.files.onDrop((grants, refused) => set("drop", grants.length > 0 ? `${grants[0].name} ${grants[0].access} ${/^grant:[0-9a-f-]{36}$/.test(grants[0].token) ? "token" : "bad-token"}` : `refused: ${note(String(refused))}`));
    return () => { window.removeEventListener("dragover", over); off(); };
  }, []);

  const open = async () => {
    const r = await api.files.pickOpen({ filters: [{ name: "Video", extensions: ["webm", "mp4"] }] });
    if (r.cancelled) return set("open", "cancelled");
    const g = r.grants[0];
    set("open", `${g.name} ${g.size} ${g.access} ${/^grant:[0-9a-f-]{36}$/.test(g.token) ? "token" : "bad-token"}`);
    const url = api.files.url(g.token);
    const range = await fetch(url, { headers: { Range: "bytes=0-9" } });
    set("range", `${range.status} ${range.headers.get("Content-Range")} ${(await range.arrayBuffer()).byteLength}`);
    const past = await fetch(url, { headers: { Range: `bytes=${g.size + 100}-` } });
    set("past", String(past.status));
    const v = video.current;
    v.onloadedmetadata = () => set("video", `${v.videoWidth}x${v.videoHeight} ${v.duration.toFixed(1)}s`);
    v.onerror = () => set("video", `error ${v.error && v.error.code}`);
    v.src = url;
    stage.current = 1;
  };
  const save = async () => {
    const r = await api.files.pickSave({ suggestedName: "export.bin" });
    if (r.cancelled) return set("save", "cancelled");
    const g = r.grants[0];
    set("save", `${g.name} ${g.access} ${/^grant:/.test(g.token) ? "token" : "bad-token"}`);
    stage.current = 2;
  };
  const click = () => {
    const step = stage.current;
    if (step === 0) { stage.current = -1; open().catch((err) => { stage.current = 0; set("open", `refused: ${note(String(err.message ?? err))}`); }); }
    else if (step === 1) { stage.current = -1; save().catch((err) => { stage.current = 1; set("save", `refused: ${note(String(err.message ?? err))}`); }); }
  };
  const text = Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join(" | ");
  return jsx("div", {
    "data-fixture": "media",
    onClick: click,
    style: { width: 360, height: 160 },
    children: [jsx("video", { ref: video, muted: true, width: 64, height: 48, key: "v" }), jsx("p", { key: "t", children: `media | ${text}` })],
  });
}
