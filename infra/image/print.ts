// Prints the official image's cloud-init (`packages/core/src/computers/image.ts`) with placeholder values, for a look
// before a live gate: `scripts/pinned-bun infra/image/print.ts`. Nothing here makes a VM or reaches a cloud, and the
// placeholders are not a real token, join ticket or release.
import { cloudInit } from "../../packages/core/src/computers/image";

const placeholder = "0".repeat(64);
process.stdout.write(cloudInit({
  name: "Cloud1",
  token: "placeholder-pairing-token-made-by-PairingTokens-mint",
  join: "placeholder-join-ticket",
  daemon: { url: "https://example.invalid/clover-core-linux-x64.tar.gz", sha256: placeholder },
  browser: { url: "https://example.invalid/chrome-headless-shell-linux64.zip", sha256: placeholder },
}));
