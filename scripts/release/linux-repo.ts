// Clover's Linux package repositories (plan §4 M-M2): an apt repository for the deb and a dnf repository for the rpm,
// both signed with an OpenPGP Ed25519 key that exists only in the owner's login Keychain. Where they are hosted is
// the owner's decision (REPO_BASE_URL is the one place that names it); nothing here creates or uploads anything
// unless the owner runs the upload by hand.
//
//   bun scripts/release/linux-repo.ts metadata --from <dir>[,…] --channel latest|beta --out <dir>   (Linux, CI)
//       the repositories' unsigned layout and metadata from the release's debs and rpms: apt's pool and
//       dists/<suite> (apt-ftparchive), dnf's packages and repodata (createrepo_c)
//   bun scripts/release/linux-repo.ts sign --dir <dir>                                            (the owner's Mac)
//       signs apt's Release (InRelease, Release.gpg) and dnf's repomd.xml (repomd.xml.asc) with the Keychain's key,
//       after checking it is the one committed in packaging/linux/clover-archive-keyring.asc
//   bun scripts/release/linux-repo.ts upload --dir <dir> [--yes]                                  (the owner's Mac)
//       prints the upload of the signed tree (wrangler r2 object put, one file each); runs it only with --yes
//   bun scripts/release/linux-repo.ts key --generate | --check                                    (the owner's Mac)
//       makes the key (the private half to the Keychain, the public half into the keyring file) or checks it
//
// Suites: `stable` holds latest releases, `beta` beta ones. The rpm repository's metadata is signed and lists each
// package's SHA-256 (dnf's repo_gpgcheck), so the packages need no signature of their own.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as openpgp from "openpgp";
import type { Channel } from "./lib";
import { parseChannel } from "./lib";

/** Where the repositories are served: the owner's choice, pending (the controller's ruling). */
export const REPO_BASE_URL = "https://packages.waifucave.com";
/** The bucket the owner's upload writes to (R2), with the same caveat. */
export const REPO_BUCKET = "clover-packages";
export const KEYRING_FILE = "packaging/linux/clover-archive-keyring.asc";
export const REPO_KEY_ITEM = { service: "com.waifucave.clover.release", name: "linux-repo-openpgp" } as const;

export function suiteFor(channel: Channel): "stable" | "beta" {
  return channel === "latest" ? "stable" : "beta";
}

/** How long a signed Release stays valid (30 days, the controller's ruling, pending the owner): apt refuses it after, so the owner re-signs and
 *  uploads the repository within that window. */
export const RELEASE_VALID_DAYS = 30;

/** apt-ftparchive's Release settings for a suite; `now` sets Date and Valid-Until. */
export function releaseConfig(suite: string, now: Date = new Date()): string[] {
  const until = new Date(now.getTime() + RELEASE_VALID_DAYS * 86_400_000);
  return [
    "-o", `APT::FTPArchive::Release::Date=${now.toUTCString().replace("GMT", "UTC")}`,
    "-o", `APT::FTPArchive::Release::Valid-Until=${until.toUTCString().replace("GMT", "UTC")}`,
    "-o", "APT::FTPArchive::Release::Origin=Clover",
    "-o", "APT::FTPArchive::Release::Label=Clover",
    "-o", `APT::FTPArchive::Release::Suite=${suite}`,
    "-o", `APT::FTPArchive::Release::Codename=${suite}`,
    "-o", "APT::FTPArchive::Release::Architectures=amd64 arm64",
    "-o", "APT::FTPArchive::Release::Components=main",
  ];
}

/** The lines a user adds, for the docs and the repository's own index page. */
export function installLines(suite: "stable" | "beta"): { apt: string[]; dnf: string[] } {
  return {
    apt: [
      `curl -fsSL ${REPO_BASE_URL}/clover-archive-keyring.asc | sudo tee /etc/apt/keyrings/clover.asc > /dev/null`,
      `echo "deb [signed-by=/etc/apt/keyrings/clover.asc] ${REPO_BASE_URL}/apt ${suite} main" | sudo tee /etc/apt/sources.list.d/clover.list`,
      "sudo apt update && sudo apt install clover",
    ],
    dnf: [
      `sudo tee /etc/yum.repos.d/clover.repo <<'EOF'`,
      "[clover]",
      `name=Clover (${suite})`,
      `baseurl=${REPO_BASE_URL}/rpm/${suite}/$basearch`,
      "enabled=1",
      "repo_gpgcheck=1",
      "gpgcheck=0",
      `gpgkey=${REPO_BASE_URL}/clover-archive-keyring.asc`,
      "EOF",
      "sudo dnf install clover",
    ],
  };
}

const run = (cmd: string[], cwd: string): string => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if ((r.status ?? 1) !== 0) throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed: ${(r.stderr ?? "").slice(-1000)}`);
  return r.stdout ?? "";
};

/** The deb's and rpm's architecture, from their file names (electron-builder's names, lib.ts's installers). */
export function archOf(name: string): { kind: "deb" | "rpm"; arch: string } | undefined {
  let m = /^clover_.+_(amd64|arm64)\.deb$/.exec(name);
  if (m) return { kind: "deb", arch: m[1]! };
  m = /^clover-.+\.(x86_64|arm64|aarch64)\.rpm$/.exec(name);
  if (m) return { kind: "rpm", arch: m[1] === "x86_64" ? "x86_64" : "aarch64" };
  return undefined;
}

function metadata(from: string[], channel: Channel, out: string): void {
  const suite = suiteFor(channel);
  for (const dir of from) {
    for (const name of readdirSync(dir)) {
      const k = archOf(name);
      if (k === undefined) continue;
      const to = k.kind === "deb" ? join(out, "apt", "pool", "main", "c", "clover") : join(out, "rpm", suite, k.arch, "packages");
      mkdirSync(to, { recursive: true });
      copyFileSync(join(dir, name), join(to, name));
    }
  }
  const apt = join(out, "apt");
  for (const arch of ["amd64", "arm64"]) {
    const bin = join(apt, "dists", suite, "main", `binary-${arch}`);
    mkdirSync(bin, { recursive: true });
    const packages = run(["apt-ftparchive", "--arch", arch, "packages", "pool"], apt);
    writeFileSync(join(bin, "Packages"), packages);
    writeFileSync(join(bin, "Packages.gz"), Bun.gzipSync(new TextEncoder().encode(packages)));
  }
  writeFileSync(join(apt, "dists", suite, "Release"), run(["apt-ftparchive", ...releaseConfig(suite), "release", join("dists", suite)], apt));
  for (const arch of ["x86_64", "aarch64"]) {
    const repo = join(out, "rpm", suite, arch);
    if (existsSync(repo)) run(["createrepo_c", "--quiet", repo], out);
  }
}

// ---- the key and the signatures (openpgp.js, in memory: the private key never touches the disk) ----

export interface RepoKeyStore {
  get(item: typeof REPO_KEY_ITEM): Promise<string | null>;
  set(item: typeof REPO_KEY_ITEM & { value: string }): Promise<void>;
}
export const repoKeychain: RepoKeyStore = { get: (i) => Bun.secrets.get(i), set: (i) => Bun.secrets.set(i) };

export async function generateRepoKey(): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Clover packages", email: "w@waifucave.com" }], format: "armored" });
  const fingerprint = (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint();
  return { privateKey, publicKey, fingerprint };
}

/** The Keychain's private key, checked against the committed public key (never signs with one users can't check). */
export async function repoSigningKey(store: RepoKeyStore, committedPublic: string | undefined): Promise<openpgp.PrivateKey> {
  if (committedPublic === undefined) throw new Error(`there is no ${KEYRING_FILE} yet: the owner runs \`linux-repo.ts key --generate\` and commits it`);
  const armored = await store.get(REPO_KEY_ITEM);
  if (armored === null) throw new Error(`the login Keychain has no ${REPO_KEY_ITEM.service} / ${REPO_KEY_ITEM.name}`);
  const key = await openpgp.readPrivateKey({ armoredKey: armored });
  const pub = await openpgp.readKey({ armoredKey: committedPublic });
  if (key.getFingerprint() !== pub.getFingerprint()) throw new Error(`the Keychain's repository key is not the one in ${KEYRING_FILE}`);
  return key;
}

/**
 * apt's two signatures over Release: the clearsigned InRelease (text, as apt reads it) and Release.gpg, detached over
 * the file's exact bytes (a binary signature, not text mode); dnf's repomd.xml.asc is detached over its bytes too.
 */
export async function signRelease(bytes: Uint8Array, key: openpgp.PrivateKey): Promise<{ inRelease: string; detached: string }> {
  const inRelease = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }), signingKeys: key });
  const detached = await openpgp.sign({ message: await openpgp.createMessage({ binary: bytes }), signingKeys: key, detached: true, format: "armored" });
  return { inRelease: inRelease as string, detached: detached as string };
}

export async function verifyDetached(bytes: Uint8Array, signature: string, publicKey: string): Promise<boolean> {
  try {
    const r = await openpgp.verify({ message: await openpgp.createMessage({ binary: bytes }), signature: await openpgp.readSignature({ armoredSignature: signature }), verificationKeys: await openpgp.readKey({ armoredKey: publicKey }) });
    await r.signatures[0]!.verified;
    return true;
  } catch {
    return false;
  }
}

/** Whether a clearsigned InRelease verifies and says exactly Release's text. */
export async function verifyInRelease(inRelease: string, release: Uint8Array, publicKey: string): Promise<boolean> {
  try {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: inRelease });
    const r = await openpgp.verify({ message, verificationKeys: await openpgp.readKey({ armoredKey: publicKey }) });
    await r.signatures[0]!.verified;
    return r.data === new TextDecoder().decode(release);
  } catch {
    return false;
  }
}

/** Every signature in a signed tree, checked against the committed key; the problems (none means all good). */
export async function verifyTree(dir: string, publicKey: string): Promise<string[]> {
  const problems: string[] = [];
  let checked = 0;
  for (const suite of ["stable", "beta"]) {
    const release = join(dir, "apt", "dists", suite, "Release");
    if (existsSync(release)) {
      const bytes = new Uint8Array(readFileSync(release));
      const inRelease = join(dirname(release), "InRelease");
      const gpg = join(dirname(release), "Release.gpg");
      if (!existsSync(inRelease) || !(await verifyInRelease(readFileSync(inRelease, "utf8"), bytes, publicKey))) problems.push(`${relative(dir, inRelease)} doesn't verify`);
      if (!existsSync(gpg) || !(await verifyDetached(bytes, readFileSync(gpg, "utf8"), publicKey))) problems.push(`${relative(dir, gpg)} doesn't verify`);
      checked++;
    }
    for (const arch of ["x86_64", "aarch64"]) {
      const repomd = join(dir, "rpm", suite, arch, "repodata", "repomd.xml");
      if (!existsSync(repomd)) continue;
      const asc = `${repomd}.asc`;
      if (!existsSync(asc) || !(await verifyDetached(new Uint8Array(readFileSync(repomd)), readFileSync(asc, "utf8"), publicKey))) problems.push(`${relative(dir, asc)} doesn't verify`);
      checked++;
    }
  }
  if (checked === 0) problems.push("the tree holds no repository metadata");
  return problems;
}

/** The owner's steps (sign, upload, key) run on their Mac alone: never in CI, never elsewhere. */
export function ownerOnly(env: Record<string, string | undefined>, platform: string): string | undefined {
  if (env.CI || env.GITHUB_ACTIONS) return "this is the owner's step, and it never runs in CI";
  if (platform !== "darwin") return "this is the owner's step, on their Mac (the key is in its login Keychain)";
  return undefined;
}

async function sign(dir: string, root: string): Promise<void> {
  const committed = existsSync(join(root, KEYRING_FILE)) ? readFileSync(join(root, KEYRING_FILE), "utf8") : undefined;
  const key = await repoSigningKey(repoKeychain, committed);
  for (const suite of ["stable", "beta"]) {
    const release = join(dir, "apt", "dists", suite, "Release");
    if (existsSync(release)) {
      const s = await signRelease(new Uint8Array(readFileSync(release)), key);
      writeFileSync(join(dirname(release), "InRelease"), s.inRelease);
      writeFileSync(join(dirname(release), "Release.gpg"), s.detached);
    }
    for (const arch of ["x86_64", "aarch64"]) {
      const repomd = join(dir, "rpm", suite, arch, "repodata", "repomd.xml");
      if (existsSync(repomd)) writeFileSync(`${repomd}.asc`, (await signRelease(new Uint8Array(readFileSync(repomd)), key)).detached);
    }
  }
  copyFileSync(join(root, KEYRING_FILE), join(dir, "clover-archive-keyring.asc"));
  const problems = await verifyTree(dir, committed!);
  if (problems.length > 0) throw new Error(`the signatures don't verify: ${problems.join("; ")}`);
}

/** Every file of the signed tree, with its object key, for the upload. */
export function uploadPlan(dir: string): Array<{ file: string; key: string }> {
  const out: Array<{ file: string; key: string }> = [];
  const walk = (p: string): void => {
    if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) walk(join(p, n)); return; }
    out.push({ file: p, key: relative(dir, p).split("\\").join("/") });
  };
  walk(dir);
  return out;
}

/** The upload of one file, with the wrangler the repo pins (the root devDependency, as the services pin it): never
 *  whatever bunx would fetch. */
export function uploadArgs(file: string, key: string, root: string): string[] {
  return [join(root, "node_modules", ".bin", "wrangler"), "r2", "object", "put", `${REPO_BUCKET}/${key}`, "--file", file, "--remote"];
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  const [cmd, ...rest] = argv;
  const value = (flag: string): string | undefined => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === "metadata") {
      if (process.platform !== "linux") throw new Error("the metadata is made on Linux (apt-ftparchive, createrepo_c): CI's job");
      const from = (value("--from") ?? "").split(",").filter(Boolean);
      const out = value("--out");
      if (from.length === 0 || out === undefined) throw new Error("metadata takes --from <dir>[,…] and --out <dir>");
      metadata(from, parseChannel(value("--channel")), out);
      console.log(`linux-repo: the ${suiteFor(parseChannel(value("--channel")))} repositories' metadata is in ${out} (unsigned)`);
      return 0;
    }
    if (cmd === "sign" || cmd === "upload" || cmd === "key") {
      const refused = ownerOnly(process.env, process.platform);
      if (refused !== undefined) throw new Error(refused);
    }
    if (cmd === "sign") {
      const dir = value("--dir");
      if (dir === undefined) throw new Error("sign takes --dir <dir>");
      await sign(dir, root);
      console.log(`linux-repo: signed ${dir}`);
      return 0;
    }
    if (cmd === "upload") {
      const dir = value("--dir");
      if (dir === undefined) throw new Error("upload takes --dir <dir>");
      if (!existsSync(join(dir, "clover-archive-keyring.asc"))) throw new Error("the tree isn't signed: run sign first");
      // Every signature checks against the committed key before anything leaves this Mac.
      const committed = readFileSync(join(root, KEYRING_FILE), "utf8");
      const bad = await verifyTree(dir, committed);
      if (bad.length > 0) throw new Error(`not uploading: ${bad.join("; ")}`);
      if (readFileSync(join(dir, "clover-archive-keyring.asc"), "utf8") !== committed) throw new Error("the tree's keyring is not the committed one");
      const plan = uploadPlan(dir);
      for (const p of plan) console.log(`  ${uploadArgs(p.file, p.key, root).join(" ")}`);
      if (!rest.includes("--yes")) { console.log(`linux-repo: ${plan.length} files to ${REPO_BUCKET}, nothing uploaded (add --yes)`); return 0; }
      for (const p of plan) run(uploadArgs(p.file, p.key, root), root);
      console.log(`linux-repo: uploaded ${plan.length} files to ${REPO_BUCKET}`);
      return 0;
    }
    if (cmd === "key") {
      if (rest[0] === "--generate") {
        if (existsSync(join(root, KEYRING_FILE))) throw new Error(`${KEYRING_FILE} exists: replacing it is a key rotation`);
        if ((await repoKeychain.get(REPO_KEY_ITEM)) !== null) throw new Error("the login Keychain already holds a repository key");
        const k = await generateRepoKey();
        await repoKeychain.set({ ...REPO_KEY_ITEM, value: k.privateKey });
        writeFileSync(join(root, KEYRING_FILE), k.publicKey);
        console.log(`linux-repo: made the repository key ${k.fingerprint}; its public half is ${KEYRING_FILE}: commit it`);
        return 0;
      }
      if (rest[0] === "--check") {
        await repoSigningKey(repoKeychain, existsSync(join(root, KEYRING_FILE)) ? readFileSync(join(root, KEYRING_FILE), "utf8") : undefined);
        console.log("linux-repo: the Keychain's repository key matches the committed one");
        return 0;
      }
    }
    console.error("usage: linux-repo metadata --from <dirs> --channel latest|beta --out <dir> | sign --dir <dir> | upload --dir <dir> [--yes] | key --generate|--check");
    return 2;
  } catch (err) {
    console.error(`linux-repo: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
