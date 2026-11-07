// The update feed's public key: Ed25519, its 32 raw bytes in base64. The private half exists only in the owner's
// login Keychain, where `bun scripts/release/feed-key.ts --generate` made it; that command writes this line, and it
// is committed like any other change. Until then there is no key, and every feed is refused (fail closed).
export const UPDATE_FEED_PUBLIC_KEY: string | null = null;
