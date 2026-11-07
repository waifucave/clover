// The net log reader the UI test's off-machine assertions use: lookups, sockets and requests, from a complete log or
// one a fast exit left unterminated.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPV6_REACHABILITY_PROBE, isLoopback, offMachine, readNetLog } from "./netlog";

const dir = mkdtempSync(join(tmpdir(), "clover-netlog-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const constants = { logEventTypes: { HOST_RESOLVER_MANAGER_REQUEST: 1, UDP_CONNECT: 2, TCP_CONNECT: 3, URL_REQUEST_START_JOB: 4, OTHER: 5 } };
const events = [
  { type: 1, phase: 1, params: { host: "clover-plugin://probe.example", is_speculative: true } },
  { type: 1, phase: 1, params: { host: "localhost:80" } },
  { type: 2, phase: 1, params: { address: IPV6_REACHABILITY_PROBE } },
  { type: 3, phase: 1, params: { address_list: ["127.0.0.1:9", "93.184.216.34:443"] } },
  { type: 4, phase: 1, params: { url: "https://example.com/x" } },
  { type: 4, phase: 1, params: { url: "clover-plugin://clover/_clover/boot.js" } },
  { type: 5, phase: 1, params: {} },
];

test("reads a whole log, and one left unterminated", () => {
  const whole = join(dir, "whole.json");
  writeFileSync(whole, `{"constants": ${JSON.stringify(constants)},\n"events": [\n${events.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`);
  const cut = join(dir, "cut.json");
  writeFileSync(cut, `{"constants": ${JSON.stringify(constants)},\n"events": [\n${events.map((e) => JSON.stringify(e)).join(",\n")},\n{"type": 1, "par`);
  for (const file of [whole, cut]) {
    const a = readNetLog(file);
    expect(a.events).toBe(events.length);
    expect(a.lookups).toEqual(["probe.example", "localhost"]);
    expect(a.sockets).toEqual([IPV6_REACHABILITY_PROBE, "127.0.0.1:9", "93.184.216.34:443"]);
    expect(a.requests).toEqual(["https://example.com/x"]);
    expect(offMachine(a)).toEqual({ lookups: ["probe.example"], sockets: [IPV6_REACHABILITY_PROBE, "93.184.216.34:443"], requests: ["https://example.com/x"] });
    expect(offMachine(a, { lookups: ["probe.example"], sockets: [IPV6_REACHABILITY_PROBE] }).lookups).toEqual([]);
    expect(offMachine(a, { ports: [443] }).sockets).toEqual([]);
  }
});

test("loopback is 127/8, ::1 and localhost", () => {
  for (const a of ["127.0.0.1:80", "127.1.2.3", "[::1]:443", "::1", "localhost"]) expect(isLoopback(a), a).toBe(true);
  for (const a of ["10.0.0.1:80", "[2001:4860:4860::8888]:443", "example.com"]) expect(isLoopback(a), a).toBe(false);
});
