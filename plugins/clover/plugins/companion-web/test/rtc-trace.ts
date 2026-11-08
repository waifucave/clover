// Diagnostics for the web companion e2e: what the two WebRTC ends did, with timestamps, printed ONLY when a test fails
// (a passing run prints nothing). It observes through addEventListener, so it never replaces a handler the code under
// test sets, and every read is guarded: a missing property is skipped, never an error. It asserts nothing.
//
// Per peer connection: signalling, ICE gathering, ICE connection and connection state changes, every local candidate
// (the address list says what the machine offered), the data channels (label, open, close, error), the SCTP and DTLS
// transports' state, and the selected candidate pair, sampled once a second until the connection is up and again on
// every state change.

import { test } from "bun:test";

type Any = any; // the polyfill's objects are read by name; each read is guarded

const lines: string[] = [];
let startedAt = 0;
let peers = 0;

function note(who: string, message: string): void {
  lines.push(`+${String(Math.round(performance.now() - startedAt)).padStart(6)} ms  ${who}  ${message}`);
}

function safe<T>(read: () => T): T | string {
  try {
    return read();
  } catch (e) {
    return `(unreadable: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function pair(pc: Any): string {
  const p = safe(() => pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.());
  if (p === undefined || p === null) return "none selected";
  if (typeof p === "string") return p;
  const one = (c: Any) => (c ? `${c.type ?? "?"} ${c.address ?? "?"}:${c.port ?? "?"} ${c.protocol ?? ""}`.trim() : "?");
  return `local ${one(p.local)} <-> remote ${one(p.remote)}`;
}

function states(pc: Any): string {
  const sctp = safe(() => pc.sctp);
  const dtls = typeof sctp === "object" && sctp !== null ? safe(() => sctp.transport?.state) : undefined;
  const ice = typeof sctp === "object" && sctp !== null ? safe(() => sctp.transport?.iceTransport?.state) : undefined;
  return [
    `signalling=${safe(() => pc.signalingState)}`,
    `gathering=${safe(() => pc.iceGatheringState)}`,
    `ice=${safe(() => pc.iceConnectionState)}`,
    `connection=${safe(() => pc.connectionState)}`,
    `dtls=${dtls ?? "n/a"}`,
    `iceTransport=${ice ?? "n/a"}`,
    `sctp=${typeof sctp === "object" && sctp !== null ? safe(() => sctp.state) : "n/a"}`,
  ].join(" ");
}

function watchChannel(who: string, channel: Any, origin: string): void {
  const label = `${who} channel "${channel.label}" (${origin})`;
  note(who, `${label} readyState=${channel.readyState}`);
  for (const type of ["open", "close", "closing", "error"]) {
    channel.addEventListener?.(type, (event: Any) => note(who, `${label} ${type}${event?.error?.message ? `: ${event.error.message}` : ""}`));
  }
}

/** Wraps an environment's createPeerConnection so each connection it makes is traced. */
export function traceRtc<E extends { createPeerConnection: (config: Any) => Any }>(rtc: E): E {
  return {
    ...rtc,
    createPeerConnection: (config: Any) => {
      const pc = rtc.createPeerConnection(config);
      const who = `pc${++peers}`;
      note(who, `created ${JSON.stringify(config)}`);
      const log = (what: string) => note(who, `${what}: ${states(pc)}`);
      for (const type of ["signalingstatechange", "icegatheringstatechange", "iceconnectionstatechange", "connectionstatechange"]) {
        pc.addEventListener?.(type, () => {
          log(type);
          note(who, `selected pair: ${pair(pc)}`);
        });
      }
      pc.addEventListener?.("icecandidate", (event: Any) => {
        const c = event?.candidate;
        note(who, c?.candidate ? `local candidate ${c.candidate}` : "local candidates complete");
      });
      pc.addEventListener?.("datachannel", (event: Any) => watchChannel(who, event.channel, "remote"));
      const create = pc.createDataChannel?.bind(pc);
      if (create) {
        pc.createDataChannel = (label: string, init?: Any) => {
          const channel = create(label, init);
          watchChannel(who, channel, "local");
          return channel;
        };
      }
      const sampler = setInterval(() => {
        if (safe(() => pc.connectionState) === "closed") return clearInterval(sampler);
        note(who, `sample: ${states(pc)}; selected pair: ${pair(pc)}`);
      }, 1000);
      (sampler as { unref?: () => void }).unref?.();
      // Stop sampling once the test is over.
      stoppers.push(() => clearInterval(sampler));
      return pc;
    },
  };
}

const stoppers: (() => void)[] = [];

function dump(reason: string): void {
  console.error(`\n===== WebRTC trace (${reason}) =====\n${lines.join("\n")}\n===== end of WebRTC trace =====\n`);
}

/**
 * `test`, with the trace of that test's peer connections printed if it fails or is still running `dumpBeforeMs` before
 * its own timeout (a hung test is cut off from outside, where nothing could print). A passing test prints nothing.
 */
export function tracedTest(name: string, body: () => Promise<void>, timeoutMs: number): void {
  test(
    name,
    async () => {
      lines.length = 0;
      peers = 0;
      startedAt = performance.now();
      let finished = false;
      const hung = setTimeout(() => {
        if (!finished) dump(`"${name}" still running after ${Math.round(performance.now() - startedAt)} ms`);
      }, Math.max(1000, timeoutMs - 3000));
      try {
        await body();
      } catch (error) {
        dump(`"${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        finished = true;
        clearTimeout(hung);
        for (const stop of stoppers.splice(0)) stop();
      }
    },
    timeoutMs,
  );
}
