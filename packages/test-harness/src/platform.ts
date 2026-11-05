// Where a Clover daemon runs today. The daemon is still macOS-only code: lane C's C1 brings it to Windows and Linux
// (sockets and pipes, secrets, login start), and widens this in the same change — the harness's daemon tests and
// its preload's daemon environment follow it.
export const DAEMON_PLATFORMS: readonly NodeJS.Platform[] = ["darwin"];

export function daemonSupported(platform: NodeJS.Platform = process.platform): boolean {
  return DAEMON_PLATFORMS.includes(platform);
}
