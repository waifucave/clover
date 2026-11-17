// The person's own models, from a pick (a token the app's picker gave the page): copied into this plugin's own shared
// data with the core import's checks, listed, and removed. A temp folder stands in for the pick and the data folder.
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileStat } from "@waifucave/moss-plugin-sdk";
import { IMPORT_CAPS, ImportRefused, importModel, removeModelFiles, type ImportFormat, type PickReader } from "../server/import";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "moss-mc2-import-")); temps.push(d); return d; };

/** The host half's `files` on a pick, as the core serves it: `grant:pick` names the picked folder or file. */
function reader(picked: string): PickReader {
  const real = (p: string) => join(picked, p.replace(/^grant:pick\/?/, ""));
  const stat = (p: string): FileStat => { const st = lstatSync(p); return { path: p, type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other", size: st.size, modifiedAt: st.mtimeMs, executable: false }; };
  return {
    stat: async (p) => (existsSync(real(p)) ? { ...stat(real(p)), path: p } : null),
    list: async (p) => readdirSync(real(p)).map((n) => ({ ...stat(join(real(p), n)), path: `${p}/${n}` })),
    readBytes: async (p) => new Uint8Array(readFileSync(real(p))),
  };
}
const FORMATS: ImportFormat[] = [{ format: "live2d", name: "Live2D (Cubism)", entry: [".model3.json"], on: true }, { format: "vrm", name: "VRM", entry: [".vrm", ".glb"], on: true }, { format: "spine", name: "Spine", entry: [".skel"], on: false }];
const write = (root: string, files: Record<string, string>) => { for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); } };

test("a folder: the model under its entry file comes along, of the packs' kinds only, with its credit; nothing of a link or a dot file", async () => {
  const pick = temp();
  write(pick, { "README.txt": "Hero by someone. Personal use.\u0007", "hero/hero.model3.json": "{}", "hero/hero.moc3": "MOC3", "hero/tex/a.png": "PNG", "hero/run.sh": "rm -rf", "hero/.secret.json": "{}", "notes.psd": "PSD" });
  // A link planted in the folder (where links can be made without a privilege: not on Windows).
  const links = process.platform !== "win32";
  writeFileSync(join(pick, "outside.json"), "PROBE_SECRET=dummy123");
  if (links) symlinkSync(join(pick, "outside.json"), join(pick, "hero", "link.json"));
  const data = temp();
  const model = await importModel(reader(pick), "grant:pick", FORMATS, data, "m-1");
  expect(model).toEqual({ name: "hero", format: "live2d", file: "own/imported/m-1/hero.model3.json", credit: "Hero by someone. Personal use." });
  const copied = join(data, "shared", "own", "imported", "m-1");
  expect(readdirSync(copied).sort()).toEqual(["hero.moc3", "hero.model3.json", "tex"]);
  // The planted link's target is not in the copy (false).
  expect(existsSync(join(copied, "link.json"))).toBe(false);
  if (process.platform !== "win32") expect((statSync(join(copied, "hero.moc3")).mode & 0o777).toString(8)).toBe("600");
  removeModelFiles(data, model.file);
  expect(existsSync(copied)).toBe(false);
});

test("one file, a format no renderer that is on draws, nothing that is a model, and sizes over the caps are refused plainly", async () => {
  const one = temp();
  write(one, { "fox.vrm": "glTF" });
  expect(await importModel(reader(join(one, "fox.vrm")), "grant:pick", FORMATS, temp(), "m-2", "fox.vrm")).toEqual({ name: "fox", format: "vrm", file: "own/imported/m-2/fox.vrm" });
  const spine = temp();
  write(spine, { "a/a.skel": "x", "a/a.png": "p" });
  expect(importModel(reader(spine), "grant:pick", FORMATS, temp(), "m-3")).rejects.toThrow(/a Spine model \(format `spine`\), and no installed renderer that is on draws it/);
  const nothing = temp();
  write(nothing, { "a.txt": "hi" });
  expect(importModel(reader(nothing), "grant:pick", FORMATS, temp(), "m-4")).rejects.toThrow(ImportRefused);
  const many = temp();
  write(many, { "m.model3.json": "{}", ...Object.fromEntries(Array.from({ length: IMPORT_CAPS.files + 1 }, (_, i) => [`t/${i}.png`, "p"])) });
  expect(importModel(reader(many), "grant:pick", FORMATS, temp(), "m-5")).rejects.toThrow(`the most is ${IMPORT_CAPS.files}`);
  const big = temp();
  write(big, { "m.model3.json": "x".repeat(8 * 1024 * 1024 + 1) });
  expect(importModel(reader(big), "grant:pick", FORMATS, temp(), "m-6")).rejects.toThrow("m.model3.json is over 8 MiB");
  expect(() => removeModelFiles(temp(), "../x/y/z")).toThrow(ImportRefused);
});
