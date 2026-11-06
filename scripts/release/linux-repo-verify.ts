// The repositories' signatures against the verifiers apt and dnf's users actually run (CI's linux-repo-signatures
// job, Linux): a throwaway key signs a fixture Release and repomd.xml as `linux-repo.ts sign` does, and gpgv (apt's)
// and sqv (Debian's other verifier) must accept them, and refuse a changed Release. Then a real repository, made by
// `metadata` from a fixture deb and signed by `signTree`, goes through a real `apt-get update` from a file:// source
// (in a throwaway apt state, as this user, nothing of the runner's own apt touched): it updates and knows the
// package; a Release past its Valid-Until is refused until `refresh` (refreshTree, then signTree) renews it; and a
// changed InRelease is refused. Nothing here touches a real key.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as openpgp from "openpgp";
import { generateRepoKey, metadata, refreshTree, RELEASE_VALID_DAYS, signRelease, signTree } from "./linux-repo";

const ok = (cmd: string[]): boolean => (spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit" }).status ?? 1) === 0;

const dir = mkdtempSync(join(tmpdir(), "clover-repo-verify-"));
const k = await generateRepoKey();
const key = await openpgp.readPrivateKey({ armoredKey: k.privateKey });
writeFileSync(join(dir, "key.asc"), k.publicKey);
writeFileSync(join(dir, "key.gpg"), (await openpgp.readKey({ armoredKey: k.publicKey })).write());
const release = new TextEncoder().encode("Origin: Clover\nLabel: Clover\nSuite: stable\nCodename: stable\nValid-Until: Sat, 21 Nov 2026 00:00:00 UTC\nSHA256:\n e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 0 main/binary-amd64/Packages\n");
const s = await signRelease(release, key);
writeFileSync(join(dir, "Release"), release);
writeFileSync(join(dir, "InRelease"), s.inRelease);
writeFileSync(join(dir, "Release.gpg"), s.detached);
const repomd = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<repomd xmlns="http://linux.duke.edu/metadata/repo"><revision>1</revision></repomd>\n');
writeFileSync(join(dir, "repomd.xml"), repomd);
writeFileSync(join(dir, "repomd.xml.asc"), (await signRelease(repomd, key)).detached);
const failures: string[] = [];
const expectOk = (what: string, cmd: string[]) => { if (!ok(cmd)) failures.push(`${what} refused a good signature`); };
expectOk("gpgv Release.gpg", ["gpgv", "--keyring", join(dir, "key.gpg"), join(dir, "Release.gpg"), join(dir, "Release")]);
expectOk("gpgv InRelease", ["gpgv", "--keyring", join(dir, "key.gpg"), join(dir, "InRelease")]);
expectOk("gpgv repomd.xml.asc", ["gpgv", "--keyring", join(dir, "key.gpg"), join(dir, "repomd.xml.asc"), join(dir, "repomd.xml")]);
expectOk("sqv Release.gpg", ["sqv", "--keyring", join(dir, "key.asc"), join(dir, "Release.gpg"), join(dir, "Release")]);
expectOk("sqv repomd.xml.asc", ["sqv", "--keyring", join(dir, "key.asc"), join(dir, "repomd.xml.asc"), join(dir, "repomd.xml")]);
writeFileSync(join(dir, "Release"), new TextEncoder().encode("Origin: Clover\nSuite: changed\n"));
if (ok(["gpgv", "--keyring", join(dir, "key.gpg"), join(dir, "Release.gpg"), join(dir, "Release")])) failures.push("gpgv accepted a changed Release");
if (ok(["sqv", "--keyring", join(dir, "key.asc"), join(dir, "Release.gpg"), join(dir, "Release")])) failures.push("sqv accepted a changed Release");

// ---- a real apt-get update from a file:// repository ----
const repo = join(dir, "repo");
const pkg = join(dir, "pkg");
mkdirSync(join(pkg, "DEBIAN"), { recursive: true });
mkdirSync(join(pkg, "usr", "share", "doc", "clover-fixture"), { recursive: true });
writeFileSync(join(pkg, "DEBIAN", "control"), "Package: clover-fixture\nVersion: 0.0.1\nArchitecture: amd64\nMaintainer: Clover <w@waifucave.com>\nDescription: a fixture for the repository check\n");
writeFileSync(join(pkg, "usr", "share", "doc", "clover-fixture", "README"), "fixture\n");
const debs = join(dir, "debs");
mkdirSync(debs);
if (!ok(["dpkg-deb", "--root-owner-group", "--build", pkg, join(debs, "clover_0.0.1_amd64.deb")])) failures.push("dpkg-deb couldn't build the fixture");
// Made 40 days ago: past its Valid-Until.
const DAY = 86_400_000;
metadata([debs], "latest", repo, new Date(Date.now() - (RELEASE_VALID_DAYS + 10) * DAY));
await signTree(repo, key, k.publicKey);
const apt = join(dir, "apt-state");
for (const d of ["lists/partial", "cache/archives/partial", "trusted.d", "parts.d"]) mkdirSync(join(apt, d), { recursive: true });
writeFileSync(join(apt, "status"), "");
writeFileSync(join(apt, "sources.list"), `deb [arch=amd64 signed-by=${join(repo, "clover-archive-keyring.asc")}] file:${join(repo, "apt")} stable main\n`);
const aptOptions = [
  "-o", `Dir::Etc::sourcelist=${join(apt, "sources.list")}`, "-o", `Dir::Etc::sourceparts=${join(apt, "parts.d")}`,
  "-o", `Dir::Etc::trusted=${join(apt, "trusted.gpg")}`, "-o", `Dir::Etc::trustedparts=${join(apt, "trusted.d")}`,
  "-o", `Dir::State=${apt}`, "-o", `Dir::State::Lists=${join(apt, "lists")}`, "-o", `Dir::State::status=${join(apt, "status")}`,
  "-o", `Dir::Cache=${join(apt, "cache")}`, "-o", "Debug::NoLocking=1", "-o", "Acquire::Languages=none", "-o", "APT::Architecture=amd64",
];
const aptGet = (): { ok: boolean; out: string } => {
  const r = spawnSync("apt-get", [...aptOptions, "--error-on=any", "update"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // --error-on=any: a source that fails to download or verify fails the command, not a warning.
  return { ok: (r.status ?? 1) === 0, out };
};
const expired = aptGet();
if (expired.ok || !/expired/i.test(expired.out)) failures.push(`apt-get update didn't refuse a Release past its Valid-Until:\n${expired.out}`);
refreshTree(repo);
await signTree(repo, key, k.publicKey);
const fresh = aptGet();
if (!fresh.ok) failures.push(`apt-get update refused the refreshed, signed repository:\n${fresh.out}`);
const shown = spawnSync("apt-cache", [...aptOptions, "show", "clover-fixture"], { encoding: "utf8" });
if ((shown.status ?? 1) !== 0 || !shown.stdout.includes("Version: 0.0.1")) failures.push(`apt-cache doesn't know the repository's package:\n${shown.stdout}${shown.stderr}`);
const inReleasePath = join(repo, "apt", "dists", "stable", "InRelease");
writeFileSync(inReleasePath, readFileSync(inReleasePath, "utf8").replace("Suite: stable", "Suite: stablx"));
const tampered = aptGet();
if (tampered.ok) failures.push("apt-get update accepted a changed InRelease");

for (const f of failures) console.error(`linux-repo-verify: ${f}`);
if (failures.length === 0) console.log("linux-repo-verify: gpgv and sqv accept the signatures and refuse a changed Release; apt-get update takes the signed file:// repository, refuses it expired until refreshed, and refuses a changed InRelease");
process.exit(failures.length === 0 ? 0 : 1);
