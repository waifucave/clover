// The acceptance vault's host half, in a process of its own (`host.process: "own"`): `secrets.get` reads the key the
// user stored for its own `auth` entry. It answers the key's SHA-256 only (the run compares it with its dummy's), and
// what a name it doesn't list gave.
import { createHash } from "node:crypto";

let started;
export function start(api) { started = api; }

export const read = async (_args, ctx) => {
  const api = ctx?.api ?? started;
  const out = {};
  try {
    const key = await api.secrets.get("api-key");
    out.own = typeof key === "string" ? createHash("sha256").update(key).digest("hex") : `not a key: ${typeof key}`;
  } catch (e) {
    out.own = `refused: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  try {
    const other = await api.secrets.get("other");
    out.other = other === undefined || other === null ? "none" : "read";
  } catch (e) {
    out.other = `refused: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  return out;
};
