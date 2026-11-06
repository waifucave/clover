// A Bun Worker that reads one descriptor with blocking read(2) calls and posts what it gets: the "worker" reader of
// fdpipe.ts. Round five saw the DevTools pipe stall on Linux with an async createReadStream (the browser still
// running, nothing more arriving); this reader takes the event loop out of the read path, to compare.
import { readSync } from "node:fs";

declare const self: { onmessage: ((e: MessageEvent<{ fd: number }>) => void) | null; postMessage(m: unknown): void };

self.onmessage = (e) => {
  const fd = e.data.fd;
  const buf = Buffer.alloc(1 << 20);
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      self.postMessage({ error: String(err) });
      return;
    }
    if (n === 0) { self.postMessage({ eof: true }); return; }
    self.postMessage({ chunk: new Uint8Array(buf.subarray(0, n)) });
  }
};
