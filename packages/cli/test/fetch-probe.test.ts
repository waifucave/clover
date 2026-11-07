// `__fetch-probe` refuses anything but loopback or the one Apple URL, and any key but 32 hex characters.
import { expect, test } from "bun:test";
import { FETCH_PROBE_APPLE_URL, fetchProbeRefusal } from "../src/fetch-probe";

const KEY = "0123456789abcdef0123456789abcdef";

test("loopback and the Apple URL pass with a 32-hex key", () => {
  for (const u of ["http://127.0.0.1:4321/", "https://127.0.0.1:9/x?y=1", "http://[::1]:80/", "http://localhost:1/", FETCH_PROBE_APPLE_URL]) {
    expect(fetchProbeRefusal(u, KEY)).toBeUndefined();
  }
});

test("any other host, scheme or URL is refused", () => {
  for (const u of [
    "https://gdmf.apple.com/v2/pmv?x=1", "https://gdmf.apple.com/", "http://gdmf.apple.com/v2/pmv", "https://example.com/",
    "http://127.0.0.2/", "http://0.0.0.0/", "http://127.0.0.1.example.com/", "http://localhost.example.com/",
    "http://user:pw@127.0.0.1/", "ftp://127.0.0.1/", "file:///etc/passwd", "data:,x", "", "not a url",
  ]) {
    expect(fetchProbeRefusal(u, KEY)).toBeString();
  }
});

test("any key but exactly 32 lowercase hex is refused", () => {
  for (const k of ["", KEY.slice(1), `${KEY}0`, KEY.toUpperCase(), `sk-${KEY.slice(3)}`, `${KEY.slice(0, 31)}g`, ` ${KEY.slice(1)}`]) {
    expect(fetchProbeRefusal("http://127.0.0.1/", k)).toBeString();
  }
});
