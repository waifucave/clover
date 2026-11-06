# Clover on Linux: the package repositories

Clover ships a deb and an rpm (the main Linux packages, with the AppArmor profile Electron needs on Ubuntu) and an AppImage. The deb and the rpm also come from Clover's own repositories, so they update with the system's package manager. Both repositories are signed with one OpenPGP Ed25519 key, the Clover packages key; its public half is `packaging/linux/clover-archive-keyring.asc`, served at `https://packages.waifucave.com/clover-archive-keyring.asc`.

The repositories' address, `https://packages.waifucave.com`, is not final: hosting is the owner's decision. `REPO_BASE_URL` in `scripts/release/linux-repo.ts` is the one place that names it, and `linux-repo.test.ts` holds these lines to it.

## apt (Debian, Ubuntu)

```sh
curl -fsSL https://packages.waifucave.com/clover-archive-keyring.asc | sudo tee /etc/apt/keyrings/clover.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/clover.asc] https://packages.waifucave.com/apt stable main" | sudo tee /etc/apt/sources.list.d/clover.list
sudo apt update && sudo apt install clover
```

For the beta suite, the source line is:

```sh
echo "deb [signed-by=/etc/apt/keyrings/clover.asc] https://packages.waifucave.com/apt beta main" | sudo tee /etc/apt/sources.list.d/clover.list
```

## dnf (Fedora, RHEL)

```sh
sudo tee /etc/yum.repos.d/clover.repo <<'EOF'
[clover]
name=Clover (stable)
baseurl=https://packages.waifucave.com/rpm/stable/$basearch
enabled=1
repo_gpgcheck=1
gpgcheck=0
gpgkey=https://packages.waifucave.com/clover-archive-keyring.asc
EOF
sudo dnf install clover
```

The repository's metadata is signed and lists each package's SHA-256 (`repo_gpgcheck=1`), so dnf checks every package through it; the packages carry no signature of their own (`gpgcheck=0`). For beta, replace `stable` with `beta` in `baseurl`.

## How a release fills them

1. CI's release workflow builds the packages on each architecture and, in its `linux-repo` job, the repositories' unsigned metadata (`linux-repo.ts metadata`: apt-ftparchive, createrepo_c).
2. On the owner's Mac, `linux-repo.ts sign --dir <the downloaded artifact>` signs apt's Release (InRelease and Release.gpg) and dnf's repomd.xml with the key in the login Keychain, after checking it is the committed one.
3. `linux-repo.ts upload --dir <dir>` checks every signature against the committed key, then prints the upload (with the wrangler the repo pins); `--yes` runs it. Nothing else uploads, and `sign`, `upload` and `key` refuse to run in CI or off the Mac.

apt's Release is valid for 30 days (`Valid-Until`, `RELEASE_VALID_DAYS`): within that window the repository must be signed and uploaded again, even with no new release, or apt stops accepting it. For now that is the owner's hand step; whether the window grows or the re-sign is automated is the owner's decision, still open.

The key is made once, by the owner: `linux-repo.ts key --generate` keeps the private half in the login Keychain and writes the public half to `clover-archive-keyring.asc`, to commit. `key --check` confirms they match. The private half is never written anywhere else.
