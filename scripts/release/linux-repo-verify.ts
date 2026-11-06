// The repositories' signatures against the verifiers apt and dnf's users actually run (CI's linux-repo-signatures
// job, Linux): a throwaway key signs a fixture Release and repomd.xml as `linux-repo.ts sign` does, and gpgv (apt's)
// and sqv (Debian's other verifier) must accept them, and refuse a changed Release. Nothing here touches a real key.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as openpgp from "openpgp";
import { generateRepoKey, signRelease } from "./linux-repo";

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
for (const f of failures) console.error(`linux-repo-verify: ${f}`);
if (failures.length === 0) console.log("linux-repo-verify: gpgv and sqv accept the signatures and refuse a changed Release");
process.exit(failures.length === 0 ? 0 : 1);
