// The Linux repositories (scripts/release/linux-repo.ts): the key, the signatures, the layout and the docs' lines,
// with a throwaway key; nothing reaches the Keychain, a bucket or the network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archOf, generateRepoKey, installLines, KEYRING_FILE, MIN_DAYS_LEFT, ownerOnly, parseAptDate, refreshRelease, refreshTree, releaseConfig, releaseDateProblems, releaseFields, RELEASE_VALID_DAYS, REPO_BASE_URL, REPO_KEY_ITEM, repoSigningKey,
  signRelease, signTree, stampRelease, suiteFor, uploadArgs, uploadPlan, verifyDetached, verifyInRelease, verifyTree, type RepoKeyStore,
} from "./linux-repo";

const memory = (): RepoKeyStore & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, get: async (i) => items.get(i.name) ?? null, set: async (i) => { items.set(i.name, i.value); } };
};

describe("the Linux repositories", () => {
  test("Release is signed both ways with the Keychain's key, and only when it is the committed one", async () => {
    const k = await generateRepoKey();
    expect(k.privateKey).toContain("PRIVATE KEY BLOCK");
    expect(k.publicKey).not.toContain("PRIVATE");
    // EdDSA in a v4 key (algorithm 22): what apt's gpgv verifies; RFC 9580's Ed25519 (27) it can't.
    const pub = await (await import("openpgp")).readKey({ armoredKey: k.publicKey });
    expect(pub.keyPacket.version).toBe(4);
    expect(pub.getAlgorithmInfo()).toMatchObject({ algorithm: "eddsaLegacy", curve: "ed25519Legacy" });
    // Signing only: no encryption subkey.
    expect(pub.getSubkeys()).toHaveLength(0);
    const store = memory();
    await expect(repoSigningKey(store, undefined)).rejects.toThrow(/key --generate/);
    await expect(repoSigningKey(store, k.publicKey)).rejects.toThrow(/has no/);
    await store.set({ ...REPO_KEY_ITEM, value: k.privateKey });
    const key = await repoSigningKey(store, k.publicKey);
    await expect(repoSigningKey(store, (await generateRepoKey()).publicKey)).rejects.toThrow(/not the one in/);
    const release = new TextEncoder().encode("Origin: Clover\nSuite: stable\nDate: Fri, 06 Nov 2026 00:00:00 UTC\nValid-Until: Sun, 06 Dec 2026 00:00:00 UTC\nSHA256:\n abc 1 main/binary-amd64/Packages\n");
    const s = await signRelease(release, key);
    expect(s.inRelease).toContain("-----BEGIN PGP SIGNED MESSAGE-----");
    expect(s.inRelease).toContain("Suite: stable");
    expect(await verifyDetached(release, s.detached, k.publicKey)).toBe(true);
    expect(await verifyDetached(new TextEncoder().encode("Origin: Clover\nSuite: other\n"), s.detached, k.publicKey)).toBe(false);
    expect(await verifyInRelease(s.inRelease, release, k.publicKey)).toBe(true);
    // A tree with every signature checks; one missing or wrong is named.
    const dir = mkdtempSync(join(tmpdir(), "clover-repo-tree-"));
    mkdirSync(join(dir, "apt", "dists", "stable"), { recursive: true });
    writeFileSync(join(dir, "apt", "dists", "stable", "Release"), release);
    writeFileSync(join(dir, "apt", "dists", "stable", "InRelease"), s.inRelease);
    writeFileSync(join(dir, "apt", "dists", "stable", "Release.gpg"), s.detached);
    const at = { now: new Date(Date.UTC(2026, 10, 6, 12)) };
    expect(await verifyTree(dir, k.publicKey, at)).toEqual([]);
    expect(await verifyTree(dir, (await generateRepoKey()).publicKey, at)).toEqual(["apt/dists/stable/InRelease doesn't verify", "apt/dists/stable/Release.gpg doesn't verify"]);
    expect(await verifyTree(mkdtempSync(join(tmpdir(), "clover-repo-empty-")), k.publicKey, at)).toEqual(["the tree holds no repository metadata"]);
    // The dates are checked against now: a day before the Release's Date, and after its Valid-Until.
    expect(await verifyTree(dir, k.publicKey, { now: new Date(Date.UTC(2026, 10, 5)) })).toEqual(["apt/dists/stable/Release is dated Fri, 06 Nov 2026 00:00:00 UTC, after now"]);
    expect(await verifyTree(dir, k.publicKey, { now: new Date(Date.UTC(2026, 11, 7)) })).toEqual(["apt/dists/stable/Release expired at Sun, 06 Dec 2026 00:00:00 UTC"]);
    // A suite folder that exists holds all three files.
    rmSync(join(dir, "apt", "dists", "stable", "InRelease"));
    expect(await verifyTree(dir, k.publicKey, at)).toEqual(["apt/dists/stable/InRelease is missing"]);
    writeFileSync(join(dir, "apt", "dists", "stable", "InRelease"), s.inRelease);
    mkdirSync(join(dir, "apt", "dists", "beta"));
    expect(await verifyTree(dir, k.publicKey, at)).toEqual(["apt/dists/beta/Release is missing", "apt/dists/beta/InRelease is missing", "apt/dists/beta/Release.gpg is missing"]);
    rmSync(join(dir, "apt", "dists", "beta"), { recursive: true });
    // A Release with no Date (signed all the same) is refused.
    const undated = new TextEncoder().encode("Origin: Clover\nSuite: stable\nValid-Until: Sun, 06 Dec 2026 00:00:00 UTC\n");
    const u = await signRelease(undated, key);
    writeFileSync(join(dir, "apt", "dists", "stable", "Release"), undated);
    writeFileSync(join(dir, "apt", "dists", "stable", "InRelease"), u.inRelease);
    writeFileSync(join(dir, "apt", "dists", "stable", "Release.gpg"), u.detached);
    expect(await verifyTree(dir, k.publicKey, at)).toEqual(["apt/dists/stable/Release has 0 Date fields, not one"]);
  }, 30_000);

  test("a Release's fields and dates, value-checked", () => {
    expect(parseAptDate("Fri, 06 Nov 2026 00:00:00 UTC")?.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    for (const bad of ["garbage", "Fri, 06 Nov 2026 00:00:00 GMT", "Sat, 06 Nov 2026 00:00:00 UTC", "Fri, 31 Nov 2026 00:00:00 UTC", "Fri, 6 Nov 2026 00:00:00 UTC", "Fri, 06 Nov 2026 25:00:00 UTC", ""]) {
      expect(parseAptDate(bad)).toBeUndefined();
    }
    // Field names compare without case; continuation lines and later paragraphs aren't fields.
    const f = releaseFields("Origin: Clover\ndate: Fri, 06 Nov 2026 00:00:00 UTC\nSHA256:\n Date: not-a-field\n\nDate: second paragraph\n");
    expect(f.get("date")).toEqual(["Fri, 06 Nov 2026 00:00:00 UTC"]);
    expect(f.get("sha256")).toEqual([""]);
    const now = new Date(Date.UTC(2026, 10, 6, 12));
    const rel = (date: string, until: string): string => `Origin: Clover\nDate: ${date}\nValid-Until: ${until}\n`;
    expect(releaseDateProblems(rel("Fri, 06 Nov 2026 00:00:00 UTC", "Sun, 06 Dec 2026 00:00:00 UTC"), now)).toEqual([]);
    expect(releaseDateProblems(rel("garbage", "Sun, 06 Dec 2026 00:00:00 UTC"), now)).toEqual(['has a Date that isn\'t an apt date ("garbage")']);
    expect(releaseDateProblems(rel("Sat, 07 Nov 2026 00:00:00 UTC", "Mon, 07 Dec 2026 00:00:00 UTC"), now)).toEqual(["is dated Sat, 07 Nov 2026 00:00:00 UTC, after now"]);
    expect(releaseDateProblems(rel("Tue, 06 Oct 2026 00:00:00 UTC", "Thu, 05 Nov 2026 00:00:00 UTC"), now)).toEqual(["expired at Thu, 05 Nov 2026 00:00:00 UTC"]);
    expect(releaseDateProblems(rel("Wed, 07 Oct 2026 00:00:00 UTC", "Sun, 08 Nov 2026 00:00:00 UTC"), now)).toEqual([`has 1.5 days left (under ${MIN_DAYS_LEFT}): refresh it first`]);
    expect(releaseDateProblems(rel("Fri, 06 Nov 2026 00:00:00 UTC", "Fri, 06 Nov 2026 00:00:00 UTC"), new Date(Date.UTC(2026, 10, 5)))).toEqual(["is dated Fri, 06 Nov 2026 00:00:00 UTC, after now", `has 1.0 days left (under ${MIN_DAYS_LEFT}): refresh it first`, "has a Valid-Until that isn't after its Date"]);
    expect(releaseDateProblems(rel("Fri, 06 Nov 2026 00:00:00 UTC", "Fri, 01 Jan 2027 00:00:00 UTC"), now)).toEqual([`is valid until Fri, 01 Jan 2027 00:00:00 UTC, more than ${RELEASE_VALID_DAYS} days from now`]);
    expect(releaseDateProblems("Origin: Clover\nDate: Fri, 06 Nov 2026 00:00:00 UTC\ndate: Fri, 06 Nov 2026 00:00:00 UTC\nValid-Until: Sun, 06 Dec 2026 00:00:00 UTC\n", now)).toEqual(["has 2 Date fields, not one"]);
    // stampRelease finds a field whatever its case.
    expect(stampRelease("Origin: Clover\ndate: x\n", new Date(Date.UTC(2026, 10, 6)))).toBe("Origin: Clover\nDate: Fri, 06 Nov 2026 00:00:00 UTC\nValid-Until: Sun, 06 Dec 2026 00:00:00 UTC\n");
  });

  test("suites, Release settings, and the packages' architectures", () => {
    expect(suiteFor("latest")).toBe("stable");
    expect(suiteFor("beta")).toBe("beta");
    expect(releaseConfig("beta")).toContain("APT::FTPArchive::Release::Suite=beta");
    const cfg = releaseConfig("stable", new Date(Date.UTC(2026, 10, 6)));
    expect(cfg).toContain("APT::FTPArchive::Release::Date=Fri, 06 Nov 2026 00:00:00 UTC");
    // apt-ftparchive takes no fixed Valid-Until from its settings: stampRelease puts it after Date.
    expect(cfg.join(" ")).not.toContain("Valid-Until");
    const written = "Origin: Clover\nCodename: stable\nDate: Fri, 06 Nov 2026 00:00:00 UTC\nArchitectures: amd64 arm64\nSHA256:\n abc 1 main/binary-amd64/Packages\n";
    const stamped = stampRelease(written, new Date(Date.UTC(2026, 10, 6)));
    expect(stamped).toBe(written.replace("Date: Fri, 06 Nov 2026 00:00:00 UTC", "Date: Fri, 06 Nov 2026 00:00:00 UTC\nValid-Until: Sun, 06 Dec 2026 00:00:00 UTC"));
    expect(stampRelease(stamped, new Date(Date.UTC(2026, 10, 6)))).toBe(stamped);
    expect(() => stampRelease("Origin: Clover\n")).toThrow(/0 Date fields/);
    expect(archOf("clover_1.2.3_amd64.deb")).toEqual({ kind: "deb", arch: "amd64" });
    expect(archOf("clover-1.2.3.arm64.rpm")).toEqual({ kind: "rpm", arch: "aarch64" });
    expect(archOf("clover-1.2.3.x86_64.rpm")).toEqual({ kind: "rpm", arch: "x86_64" });
    expect(archOf("Clover-1.2.3-x86_64.AppImage")).toBeUndefined();
  });

  test("refresh rewrites only Date and Valid-Until in each Release, and the tree is signed again", async () => {
    const release = "Origin: Clover\nLabel: Clover\nSuite: stable\nCodename: stable\nDate: Fri, 06 Nov 2026 00:00:00 UTC\nValid-Until: Sun, 06 Dec 2026 00:00:00 UTC\nArchitectures: amd64 arm64\nComponents: main\nSHA256:\n abc 1 main/binary-amd64/Packages\n";
    const now = new Date(Date.UTC(2026, 11, 1, 12));
    const out = refreshRelease(release, now);
    expect(out).toBe(release.replace("Date: Fri, 06 Nov 2026 00:00:00 UTC", "Date: Tue, 01 Dec 2026 12:00:00 UTC").replace("Valid-Until: Sun, 06 Dec 2026 00:00:00 UTC", "Valid-Until: Thu, 31 Dec 2026 12:00:00 UTC"));
    // Only those two lines differ.
    const diff = release.split("\n").filter((l, i) => l !== out.split("\n")[i]);
    expect(diff).toEqual(["Date: Fri, 06 Nov 2026 00:00:00 UTC", "Valid-Until: Sun, 06 Dec 2026 00:00:00 UTC"]);
    expect(() => refreshRelease("Origin: Clover\nDate: x\n", now)).toThrow(/0 Valid-Until fields/);
    expect(() => refreshRelease(`${release}Date: again\n`, now)).toThrow(/2 Date fields/);
    // A signed tree, refreshed: the new Release is what the signatures cover.
    const k = await generateRepoKey();
    const key = await (await import("openpgp")).readPrivateKey({ armoredKey: k.privateKey });
    const dir = mkdtempSync(join(tmpdir(), "clover-repo-refresh-"));
    mkdirSync(join(dir, "apt", "dists", "beta"), { recursive: true });
    writeFileSync(join(dir, "apt", "dists", "beta", "Release"), release.replaceAll("stable", "beta"));
    await signTree(dir, key, k.publicKey);
    expect(refreshTree(dir, now)).toBe(1);
    expect(await verifyTree(dir, k.publicKey, { now })).toEqual(["apt/dists/beta/InRelease doesn't verify", "apt/dists/beta/Release.gpg doesn't verify"]);
    await signTree(dir, key, k.publicKey);
    expect(await verifyTree(dir, k.publicKey, { now })).toEqual([]);
    expect(readFileSync(join(dir, "apt", "dists", "beta", "InRelease"), "utf8")).toContain("Valid-Until: Thu, 31 Dec 2026 12:00:00 UTC");
    expect(readFileSync(join(dir, "clover-archive-keyring.asc"), "utf8")).toBe(k.publicKey);
    expect(() => refreshTree(mkdtempSync(join(tmpdir(), "clover-repo-none-")))).toThrow(/no apt Release/);
    // The owner's step: refused in CI like sign, and the key is checked before the tree changes.
    const src = readFileSync(join(import.meta.dir, "linux-repo.ts"), "utf8");
    expect(src).toContain('if (cmd === "sign" || cmd === "refresh" || cmd === "upload" || cmd === "key")');
    const body = src.slice(src.indexOf('if (cmd === "refresh") {'));
    expect(body.indexOf("repoSigningKey(")).toBeLessThan(body.indexOf("refreshTree(dir)"));
  }, 30_000);

  test("the install lines name the one base URL, a signed-by keyring, and dnf's signed metadata", () => {
    const { apt, dnf } = installLines("stable");
    expect(apt.join("\n")).toContain(`deb [signed-by=/etc/apt/keyrings/clover.asc] ${REPO_BASE_URL}/apt stable main`);
    expect(dnf).toContain("repo_gpgcheck=1");
    expect(dnf).toContain(`baseurl=${REPO_BASE_URL}/rpm/stable/$basearch`);
    const doc = readFileSync(join(import.meta.dir, "..", "..", "packaging", "linux", "README.md"), "utf8");
    for (const line of [...apt, ...installLines("beta").apt.slice(1, 2), ...dnf]) expect(doc, line).toContain(line);
  });

  test("the upload is every file of the signed tree, by its path, and only with --yes (it prints otherwise)", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-linux-repo-"));
    mkdirSync(join(dir, "apt", "dists", "stable"), { recursive: true });
    writeFileSync(join(dir, "apt", "dists", "stable", "InRelease"), "x");
    writeFileSync(join(dir, "clover-archive-keyring.asc"), "k");
    expect(uploadPlan(dir).map((p) => p.key)).toEqual(["apt/dists/stable/InRelease", "clover-archive-keyring.asc"]);
    // The pinned wrangler (the root devDependency), never bunx's.
    expect(uploadArgs("/f", "apt/x", "/r")).toEqual(["/r/node_modules/.bin/wrangler", "r2", "object", "put", "clover-packages/apt/x", "--file", "/f", "--remote"]);
    expect((JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies.wrangler).toBe("4.153.0");
    expect(readFileSync(join(import.meta.dir, "linux-repo.ts"), "utf8")).not.toContain('"bunx"');
    // The owner's steps never run in CI or off the Mac.
    expect(ownerOnly({ CI: "true" }, "darwin")).toContain("never runs in CI");
    expect(ownerOnly({ GITHUB_ACTIONS: "true" }, "darwin")).toContain("never runs in CI");
    expect(ownerOnly({}, "linux")).toContain("on their Mac");
    expect(ownerOnly({}, "darwin")).toBeUndefined();
    const src = readFileSync(join(import.meta.dir, "linux-repo.ts"), "utf8");
    expect(src).toContain('if (!rest.includes("--yes"))');
    expect(src).not.toMatch(/writeFileSync\([^)]*privateKey/);
    expect(KEYRING_FILE).toBe("packaging/linux/clover-archive-keyring.asc");
  });
});
