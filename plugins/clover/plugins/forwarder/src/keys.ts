// This computer's forwarder key, as the core holds it. The controller's ruling for lane B's plugin API: the core
// keeps one X25519 key per computer and name, never synced and never handed to the plugin host (whose workers
// share memory, spec §5.2), and offers
//
//   keys.publicKey(name)        -> the 32-byte public key (made on first use)
//   keys.open(name, input)      -> HPKE base mode, single shot, with the envelope's suite:
//                                  DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM
//
// Both throw when the key store is unavailable, so the forwarder never makes a new key by mistake (which
// would leave every held webhook unopenable). Until lane B pins the API, host/api.ts declares it and the
// forwarder's tests use memoryKeys below.

import type { HpkeOpenInput } from "./wire/envelope";
import { AEAD_AES_256_GCM, generateX25519, openBase, type X25519KeyPair } from "./wire/hpke";

export interface ForwarderKeys {
  publicKey(): Promise<Uint8Array>;
  open(input: HpkeOpenInput): Promise<Uint8Array>;
}

/** The plugin API's per-computer key door, as host/api.ts assumes it. */
export interface CoreKeys {
  publicKey(name: string): Promise<Uint8Array>;
  open(name: string, input: HpkeOpenInput): Promise<Uint8Array>;
}

export function coreKeys(keys: CoreKeys, name: string): ForwarderKeys {
  return { publicKey: () => keys.publicKey(name), open: (input) => keys.open(name, input) };
}

/**
 * A key held in memory: a stand-in for the core's key store in tests and emulators. Pass a pair to keep the
 * same key across clients (one computer restarting).
 */
export async function memoryKeys(pair?: X25519KeyPair): Promise<ForwarderKeys & { pair: X25519KeyPair }> {
  const held = pair ?? (await generateX25519());
  return {
    pair: held,
    publicKey: async () => held.publicKey,
    open: (input) => openBase(AEAD_AES_256_GCM, held, input.enc, input.info, input.aad, input.ciphertext),
  };
}
