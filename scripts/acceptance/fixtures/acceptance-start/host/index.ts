// The acceptance fixture for `host.start` (§5.2): nothing calls this host half, so the only way its line reaches its
// log is that it started at once. No network, no files, no other process.
export async function start(): Promise<void> {
  console.log("acceptance-start: started with no call");
}
