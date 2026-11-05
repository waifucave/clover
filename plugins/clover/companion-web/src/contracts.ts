// The slices of lane B's contracts (packages/core/src/contracts on lane/b-m0: DeviceRegistry, LinkTransport) and
// plugin API this plugin is written against, until the spine merges to main. Names and shapes follow lane B's; each
// gap is listed in the I-M2 PR for lanes B and H.

import type { RtcLink } from "@waifucave/clover-service-web/protocol";

export type DeviceKind = "desktop" | "laptop" | "server" | "phone" | "tablet" | "browser";

/** Lane B's DeviceRecord, as far as this plugin fills it. */
export interface DeviceInput {
  id: string;
  name: string;
  kind: DeviceKind;
  runsCore: boolean;
  /** The browser's handshake key: raw 32 bytes, base64 (lane B's encoding). */
  publicKey: string;
}

export type PairingProof = { via: "code"; card: string };

export type DeviceChange = { type: "added" | "changed"; device: { id: string } } | { type: "revoked"; id: string; reason?: string };

/** Lane B's DeviceRegistry: `add` and `watch` are what this plugin uses. */
export interface DeviceRegistryLike {
  add(device: DeviceInput, proof: PairingProof): Promise<unknown>;
  watch(fn: (change: DeviceChange) => void): () => void;
}

/**
 * What the core shows the person when a browser asks to pair: the browser's name and the four words, as a sealed
 * card (spec §5.5); answers whether they confirmed, and the card's id for the registry's proof. Not in lane B's API:
 * the pairing flow is lane H's (`device.pair.*`), which this plugin hands the browser's half to.
 */
export type ConfirmPairing = (request: { browser: string; words: string[]; code: string }) => Promise<{ confirmed: boolean; card: string }>;

/**
 * Where a browser's link goes once it is up: lane H's LinkTransport, which serves the core's `web` call list over it
 * (B's contract: "the browser uses WebRTC data channels"). Not in lane B's API either.
 */
export type AdoptLink = (link: RtcLink, device: string) => void;

/** A browser pair the computer keeps: the lasting pair, the computer's signing seed for it, and the pair secret. */
export interface BrowserPair {
  pair: string;
  /** The computer's Ed25519 seed for this pair (32 bytes). */
  seed: Uint8Array;
  /** The pair secret (32 bytes). */
  secret: Uint8Array;
  browserKey: string;
  device: string;
  name: string;
  pairedAt: number;
}

/**
 * Where the computer keeps its browser pairs. They are secrets: the core's secret store holds them (lane C's store,
 * through an API lane B hasn't named yet); tests use the memory store below.
 */
export interface PairStore {
  list(): Promise<BrowserPair[]>;
  put(pair: BrowserPair): Promise<void>;
  delete(pair: string): Promise<void>;
}

export class MemoryPairStore implements PairStore {
  private readonly pairs = new Map<string, BrowserPair>();
  async list(): Promise<BrowserPair[]> {
    return [...this.pairs.values()];
  }
  async put(pair: BrowserPair): Promise<void> {
    this.pairs.set(pair.pair, pair);
  }
  async delete(pair: string): Promise<void> {
    this.pairs.delete(pair);
  }
}
