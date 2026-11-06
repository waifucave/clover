// The Linux repositories (scripts/release/linux-repo.ts): the key, the signatures, the layout and the docs' lines,
// with a throwaway key; nothing reaches the Keychain, a bucket or the network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archOf, generateRepoKey, installLines, KEYRING_FILE, ownerOnly, releaseConfig, REPO_BASE_URL, REPO_KEY_ITEM, repoSigningKey, signRelease, suiteFor,
  uploadArgs, uploadPlan, verifyDetached, verifyInRelease, verifyTree, type RepoKeyStore,
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
    const store = memory();
    await expect(repoSigningKey(store, undefined)).rejects.toThrow(/key --generate/);
    await expect(repoSigningKey(store, k.publicKey)).rejects.toThrow(/has no/);
    await store.set({ ...REPO_KEY_ITEM, value: k.privateKey });
    const key = await repoSigningKey(store, k.publicKey);
    await expect(repoSigningKey(store, (await generateRepoKey()).publicKey)).rejects.toThrow(/not the one in/);
    const release = new TextEncoder().encode("Origin: Clover\nSuite: stable\nSHA256:\n abc 1 main/binary-amd64/Packages\n");
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
    expect(await verifyTree(dir, k.publicKey)).toEqual([]);
    expect(await verifyTree(dir, (await generateRepoKey()).publicKey)).toEqual(["apt/dists/stable/InRelease doesn't verify", "apt/dists/stable/Release.gpg doesn't verify"]);
    expect(await verifyTree(mkdtempSync(join(tmpdir(), "clover-repo-empty-")), k.publicKey)).toEqual(["the tree holds no repository metadata"]);
  }, 30_000);

  test("suites, Release settings, and the packages' architectures", () => {
    expect(suiteFor("latest")).toBe("stable");
    expect(suiteFor("beta")).toBe("beta");
    expect(releaseConfig("beta")).toContain("APT::FTPArchive::Release::Suite=beta");
    const cfg = releaseConfig("stable", new Date(Date.UTC(2026, 10, 6)));
    expect(cfg).toContain("APT::FTPArchive::Release::Valid-Until=Fri, 20 Nov 2026 00:00:00 UTC");
    expect(cfg).toContain("APT::FTPArchive::Release::Date=Fri, 06 Nov 2026 00:00:00 UTC");
    expect(archOf("clover_1.2.3_amd64.deb")).toEqual({ kind: "deb", arch: "amd64" });
    expect(archOf("clover-1.2.3.arm64.rpm")).toEqual({ kind: "rpm", arch: "aarch64" });
    expect(archOf("clover-1.2.3.x86_64.rpm")).toEqual({ kind: "rpm", arch: "x86_64" });
    expect(archOf("Clover-1.2.3-x86_64.AppImage")).toBeUndefined();
  });

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
