// The tree hash (spec §5.1 "Indexes and npm"): SHA-256 over a sorted list with one line per file, its path in the
// plugin folder (with `/`), its executable bit and the SHA-256 of its bytes. It leaves out only `.DS_Store`,
// `Thumbs.db` and `.git/`, and a symlink out of the folder makes the plugin invalid. The OK is bound to it, so other
// devices don't ask again, and a host half runs only when its hash matches the main's (§8.5).
//
// The exact bytes, chosen here so every device and the official index agree:
//   - each line is `<path>\t<x or ->\t<sha256 hex of the file's bytes>\n`;
//   - a path is relative to the plugin folder, with `/`, in Unicode NFC, and holds no control character;
//   - lines are sorted by their paths' UTF-8 bytes;
//   - the hash is SHA-256 of the lines' UTF-8 bytes, written `sha256:<hex>`;
//   - `.DS_Store` and `Thumbs.db` files and `.git` folders are left out at any depth; empty folders count for nothing.
// Symlinks (settled at B-M1, in the core's `registry/tree.ts`): a symlink to a file inside the folder counts as that
// file's bytes and executable bit under the link's own path; one out of the folder, to a folder, or dangling makes the
// plugin invalid.

export interface TreeEntry {
  /** Relative to the plugin folder, with `/`. */
  path: string;
  executable: boolean;
  /** SHA-256 of the file's bytes, lowercase hex. */
  sha256: string;
}

const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/** Whether a path is left out of the hash. */
export function isTreeHashExcluded(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => p === ".git")) return true;
  return EXCLUDED_FILES.has(parts[parts.length - 1]!);
}

/** Why a path can't be in a plugin tree, or null when it can. */
export function treePathProblem(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absolute path";
  if (path.includes("\\")) return "a backslash; paths use /";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "a control character";
  if (path.split("/").some((p) => p === "" || p === "." || p === "..")) return "an empty, . or .. segment";
  if (path.normalize("NFC") !== path) return "not in Unicode NFC";
  return null;
}

function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** The text the tree hash is taken over. Throws on a path that can't be in a tree or on a duplicate. */
export function treeHashInput(entries: readonly TreeEntry[]): string {
  const kept = entries.filter((e) => !isTreeHashExcluded(e.path));
  const seen = new Set<string>();
  for (const e of kept) {
    const problem = treePathProblem(e.path);
    if (problem) throw new Error(`tree hash: ${JSON.stringify(e.path)} has ${problem}`);
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`tree hash: ${JSON.stringify(e.path)} has no SHA-256`);
    if (seen.has(e.path)) throw new Error(`tree hash: ${JSON.stringify(e.path)} appears twice`);
    seen.add(e.path);
  }
  return [...kept]
    .sort((a, b) => compareUtf8(a.path, b.path))
    .map((e) => `${e.path}\t${e.executable ? "x" : "-"}\t${e.sha256}\n`)
    .join("");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of some bytes, lowercase hex (WebCrypto, so it runs in the daemon, the CLI and the app alike). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** The tree hash, `sha256:<hex>`. */
export async function treeHash(entries: readonly TreeEntry[]): Promise<string> {
  return `sha256:${await sha256Hex(treeHashInput(entries))}`;
}
