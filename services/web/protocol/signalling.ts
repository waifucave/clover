// WebRTC signalling over a pair's handshake channel (PROTOCOL.md's `signal` kind): the page offers, the computer
// answers, and both trickle their ICE candidates. Each attempt is a session with its own id, so a stale answer or
// candidate from an earlier attempt is ignored.
//
//   {v:1, at, session, type:"offer", sdp}        page -> computer
//   {v:1, at, session, type:"answer", sdp}       computer -> page
//   {v:1, at, session, type:"candidate", candidate:{candidate, sdpMid, sdpMLineIndex}}   both ways
//   {v:1, at, session, type:"end"}               either way: give up on this session

import { b64u } from "../../shared/encoding";
import type { ChannelEvent, PairChannel } from "@waifucave/clover-service-handshake/client";
import { type ChannelLike, LinkError, RtcLink } from "./rtc-link";

export interface SignalMessage {
  v: 1;
  at: number;
  session: string;
  type: "offer" | "answer" | "candidate" | "end";
  sdp?: string;
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
}

/** The RTCPeerConnection surface signalling needs: a browser's, or node-datachannel's polyfill. */
export interface PeerConnection {
  createDataChannel(label: string, init?: { ordered?: boolean }): ChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description?: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  readonly localDescription: { type: string; sdp: string } | null;
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }) => void) | null;
  ondatachannel: ((event: { channel: ChannelLike }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  readonly connectionState: string;
  close(): void;
}

export interface RtcEnvironment {
  createPeerConnection(config: { iceServers: { urls: string | string[] }[] }): PeerConnection;
  iceServers: { urls: string | string[] }[];
}

/** Public STUN servers, so a browser and a computer behind ordinary routers find a direct path (spec §8.3). */
export const DEFAULT_ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export function isSignal(value: Record<string, unknown>): value is SignalMessage & Record<string, unknown> {
  return value.v === 1 && typeof value.session === "string" && ["offer", "answer", "candidate", "end"].includes(String(value.type));
}

/** Routes a channel's `signal` messages to the session they belong to; offers go to `onOffer`. */
export class SignalRouter {
  private readonly sessions = new Map<string, (message: SignalMessage) => void>();
  private readonly early = new Map<string, SignalMessage[]>();
  onOffer: ((message: SignalMessage) => void) | null = null;
  /** Signal messages that aren't signalling (the pairing exchange uses the same kind). */
  onOther: ((value: Record<string, unknown>) => void) | null = null;

  feed(event: ChannelEvent): void {
    if (event.type !== "message" || event.kind !== "signal") return;
    const value = event.value;
    if (!isSignal(value)) {
      this.onOther?.(value);
      return;
    }
    if (value.type === "offer") {
      this.onOffer?.(value);
      return;
    }
    const handler = this.sessions.get(value.session);
    if (handler) handler(value);
    else {
      // A candidate can overtake the session's set-up on this end: keep a few, briefly.
      const list = this.early.get(value.session) ?? [];
      if (list.length < 32) list.push(value);
      this.early.set(value.session, list);
      setTimeout(() => this.early.delete(value.session), 30_000);
    }
  }

  subscribe(session: string, fn: (message: SignalMessage) => void): () => void {
    this.sessions.set(session, fn);
    for (const message of this.early.get(session) ?? []) fn(message);
    this.early.delete(session);
    return () => this.sessions.delete(session);
  }
}

function send(channel: PairChannel, message: Omit<SignalMessage, "v" | "at">): Promise<unknown> {
  return channel.send("signal", { v: 1, at: Date.now(), ...message }).catch(() => undefined);
}

function waitOpen(channel: ChannelLike, timeoutMs: number): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LinkError("timeout", "the data channel did not open")), timeoutMs);
    const prior = channel.onopen;
    channel.onopen = (event) => {
      clearTimeout(timer);
      prior?.(event);
      resolve();
    };
  });
}

/** Wires a peer connection's candidates and remote messages for one session; the caller says when it's done. */
function trickle(pc: PeerConnection, channel: PairChannel, router: SignalRouter, session: string, onAnswer?: (sdp: string) => Promise<void>) {
  const queued: SignalMessage["candidate"][] = [];
  let remoteSet = false;
  let ended: ((error: Error) => void) | null = null;
  const endedPromise = new Promise<never>((_, reject) => {
    ended = reject;
  });
  endedPromise.catch(() => undefined);
  pc.onicecandidate = (event) => {
    if (event.candidate?.candidate) {
      void send(channel, { session, type: "candidate", candidate: { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid ?? null, sdpMLineIndex: event.candidate.sdpMLineIndex ?? null } });
    }
  };
  const unsubscribe = router.subscribe(session, (message) => {
    if (message.type === "answer" && message.sdp && onAnswer) {
      void onAnswer(message.sdp).then(
        async () => {
          remoteSet = true;
          for (const c of queued.splice(0)) await pc.addIceCandidate(c!).catch(() => undefined);
        },
        (err: unknown) => ended?.(err instanceof Error ? err : new Error("bad answer")),
      );
    } else if (message.type === "candidate" && message.candidate) {
      if (remoteSet) void pc.addIceCandidate(message.candidate).catch(() => undefined);
      else queued.push(message.candidate);
    } else if (message.type === "end") ended?.(new LinkError("refused", "the other end gave up"));
  });
  return {
    unsubscribe,
    ended: endedPromise,
    remoteSet: async () => {
      remoteSet = true;
      for (const c of queued.splice(0)) await pc.addIceCandidate(c!).catch(() => undefined);
    },
  };
}

/** The page's side: offers a connection to the computer and resolves with the link once its channels are open. */
export async function dial(options: {
  channel: PairChannel;
  router: SignalRouter;
  rtc: RtcEnvironment;
  peer: string;
  timeoutMs?: number;
}): Promise<RtcLink> {
  const { channel, router, rtc, peer } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const session = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const pc = rtc.createPeerConnection({ iceServers: rtc.iceServers });
  const control = pc.createDataChannel("control", { ordered: true });
  const tokens = pc.createDataChannel("tokens", { ordered: true });
  const wiring = trickle(pc, channel, router, session, (sdp) => pc.setRemoteDescription({ type: "answer", sdp }));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new LinkError("failed", "no local description");
    await send(channel, { session, type: "offer", sdp });
    await Promise.race([Promise.all([waitOpen(control, timeoutMs), waitOpen(tokens, timeoutMs)]), wiring.ended]);
  } catch (err) {
    wiring.unsubscribe();
    void send(channel, { session, type: "end" });
    pc.close();
    throw err;
  }
  wiring.unsubscribe();
  pc.onicecandidate = null;
  const link = new RtcLink({ peer, pc, control, tokens });
  pc.ondatachannel = (event) => link.adoptChannel(event.channel);
  watchConnection(pc, link);
  return link;
}

/** The computer's side: answers an offer and resolves with the link once the page's channels are open. */
export async function answer(options: {
  channel: PairChannel;
  router: SignalRouter;
  rtc: RtcEnvironment;
  offer: SignalMessage;
  peer: string;
  timeoutMs?: number;
}): Promise<RtcLink> {
  const { channel, router, rtc, offer, peer } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pc = rtc.createPeerConnection({ iceServers: rtc.iceServers });
  const wiring = trickle(pc, channel, router, offer.session);
  const channels = new Map<string, ChannelLike>();
  const streams: ChannelLike[] = [];
  let link: RtcLink | null = null;
  const both = new Promise<void>((resolve) => {
    pc.ondatachannel = (event) => {
      const ch = event.channel;
      if (ch.label === "control" || ch.label === "tokens") {
        channels.set(ch.label, ch);
        if (channels.size === 2) resolve();
      } else if (link) link.adoptChannel(ch);
      else streams.push(ch);
    };
  });
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp ?? "" });
    await wiring.remoteSet();
    await pc.setLocalDescription(await pc.createAnswer());
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new LinkError("failed", "no local description");
    await send(channel, { session: offer.session, type: "answer", sdp });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new LinkError("timeout", "the page's channels did not arrive")), timeoutMs));
    await Promise.race([both, timeout, wiring.ended]);
    await Promise.all([waitOpen(channels.get("control")!, timeoutMs), waitOpen(channels.get("tokens")!, timeoutMs)]);
  } catch (err) {
    wiring.unsubscribe();
    void send(channel, { session: offer.session, type: "end" });
    pc.close();
    throw err;
  }
  wiring.unsubscribe();
  pc.onicecandidate = null;
  link = new RtcLink({ peer, pc, control: channels.get("control")!, tokens: channels.get("tokens")! });
  for (const ch of streams.splice(0)) link.adoptChannel(ch);
  watchConnection(pc, link);
  return link;
}

function watchConnection(pc: PeerConnection, link: RtcLink): void {
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") link.close(`the connection ${pc.connectionState}`);
  };
}
