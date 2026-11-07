# The official image for cloud computers

Spec §9.2 "Official image" and "Safety"; plan §4 J, M3.

A cloud computer is a stock Ubuntu 24.04 VM that the provider plugin (`plugins/clover/plugins/provider-hetzner`,
`provider-gcp`) creates with the cloud-init the core writes (`packages/core/src/computers/image.ts`). There is no
prebuilt disk image to publish: the cloud-init is the image. It:

- first of all, blocks the cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `fd20:ce::254`) with
  nftables for every user: in `bootcmd` when the image has nft already, and again as the first `runcmd` lines, which
  also keep the rule across boots and enable nftables, before any download or user service (loading it twice is
  harmless);
- downloads the Clover daemon for Linux and Chrome for Testing's headless shell from pinned URLs and checks each one's
  SHA-256 before anything is unpacked (lane M's release pins);
- adds a `clover` user with no password, turns lingering on for it, and runs the daemon as a systemd user service, so
  it starts at boot with no login;
- writes the computer's name, its join ticket and its single-use pairing token to `/etc/clover/`, readable only by
  `clover`; the daemon pairs once with the token and then deletes the token and the join ticket
  (`removeCloudJoinFiles`). Google Cloud's `user-data` metadata is cleared after pairing too; Hetzner keeps a server's
  user-data and can't clear it, but the token in it is spent;
- carries the `clover-computer` label with its folder's id, by which the main computer finds it (`cloud.json` is only
  a cache).

The providers give the VM no cloud service account (Google Cloud: `serviceAccounts: []`; Hetzner has none), so even
without the block there is nothing to lift.

To see what a VM gets: `scripts/pinned-bun infra/image/print.ts`. It prints the cloud-init with placeholder values.

Open before the live gate:

- the daemon's flags `--headless`, `--name-file`, `--pairing-token-file` and `--join-file` are lane J's proposal (lanes
  A, H and M);
- the release URLs and hashes come from lane M's Linux build;
- a desktop session for computer use comes with opensky, not here.
