// `device.programKey.set` (lane RT, spec revision 19 ruling C): one answer key per (device, program), the program being
// the calling connection's (`MossConn.program`: its signed identity on macOS, its surface elsewhere), never a word in
// the call. The first key of a program, and the same key again, apply at once. Another key in place of a held one is a
// sensitive change, as replacing the device's single key is (`device.answerKey.set`): it takes the held key's
// hand-over (`programAnswerKeyRotateStatement`, checked before any card shows) and the user's yes on a sealed change card
// bound to exactly that hand-over, and the key changes only on that yes (`ProgramKeyTable.replace`, which checks again).
// As for the single key, this device's own signed answer never approves its own key's replacement.
import { createHash } from "node:crypto";
import { ERR, MOSS_ERR, SURFACES_METHODS, type ChangeResult, type Program } from "@waifucave/moss-protocol";
import { answerKeyFingerprint } from "../approvals/answer-key-rotation";
import { boundCardRecord, callBindingOf, type ApprovalBroker, type CallRequestBinding } from "../contracts/approval-broker";
import { isContractError } from "../contracts/common";
import { MossRpcError, type MossHandler } from "../ipc/moss";
import type { ProgramKeyHandOver, ProgramKeyInput, ProgramKeyTable } from "./program-keys";

/** The call the card binds; a binding only, never a method on the wire. */
export const PROGRAM_KEY_ROTATE = "device.programKey.rotate";

const NAMES: Record<Program, string> = { moss: "MOSS", code: "MOSS Code", host: "MOSS's background helper" };

export interface ProgramKeyMethodsDeps {
  table: () => ProgramKeyTable | undefined;
  /** This computer's device id. */
  device: () => string;
  /** The broker and this computer's name, for a replacement's card; undefined until the approvals run. */
  rotation: () => { broker: Pick<ApprovalBroker, "request" | "get" | "watch">; computer: string } | undefined;
  log?: (line: string) => void;
}

const REFUSED: Record<string, string> = {
  "no-current-key": "this program holds no answer key yet",
  "same-key": "that is the key this program holds",
  "not-current": "the hand-over isn't from the key this program holds",
  stale: "the hand-over is too old: sign a new one",
  "bad-signature": "the hand-over doesn't verify",
};

export function programKeyMethods(deps: ProgramKeyMethodsDeps): Record<string, MossHandler> {
  let rotating: AbortController | undefined;
  return {
    [SURFACES_METHODS.deviceProgramKeySet.name]: async (conn, params): Promise<ChangeResult> => {
      const program = conn.program;
      if (conn.role !== "app" || program === undefined) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "only a program of this desktop holds its answer key");
      const table = deps.table();
      if (table === undefined) throw new MossRpcError(ERR.RETRY, "this computer's answer keys aren't open yet: try again in a moment");
      const p = params as { publicKey: string; held: ProgramKeyInput["held"]; alg?: ProgramKeyInput["alg"]; signature: string; rotation?: ProgramKeyHandOver };
      const input: ProgramKeyInput = { device: deps.device(), program, publicKey: p.publicKey, held: p.held, ...(p.alg !== undefined ? { alg: p.alg } : {}), signature: p.signature };
      let r;
      try {
        r = await table.register(input);
      } catch (err) {
        if (isContractError(err)) throw new MossRpcError(ERR.INVALID_PARAMS, err.message);
        throw err;
      }
      if (r.applied) return { applied: true };
      // MOSS Code's key is the device's single key: its own door replaces it (a card here could only be approved for nothing).
      if (program === "code" && table.codeIsSingleKey(input.device)) throw new MossRpcError(ERR.INVALID_REQUEST, "MOSS Code's key is this desktop's single answer key: device.answerKey.set replaces it", { code: "single-key" });
      if (!p.rotation) throw new MossRpcError(ERR.INVALID_REQUEST, "this program already has an answer key: replacing it takes the current key's hand-over");
      const why = await table.checkHandOver(input, p.rotation);
      if (why !== "ok") throw new MossRpcError(ERR.INVALID_REQUEST, REFUSED[why] ?? "refused", { code: why });
      const asked = deps.rotation();
      if (asked === undefined) throw new MossRpcError(ERR.RETRY, "replacing an answer key takes the approvals, which aren't running on this computer yet: try again in a moment");
      // One replacement at a time: this one's card withdraws the one before.
      rotating?.abort();
      const ctl = new AbortController();
      rotating = ctl;
      const held = table.keyOf(input.device, program)!;
      const binds: CallRequestBinding = {
        computer: asked.computer, method: PROGRAM_KEY_ROTATE,
        params: { device: input.device, program, from: held.publicKey, fromAlg: held.alg ?? "ed25519", to: input.publicKey, toAlg: input.alg ?? "ed25519", held: input.held, at: p.rotation.at },
      };
      const sealed = callBindingOf(binds, (text) => createHash("sha256").update(text).digest("hex"));
      const handOver = p.rotation;
      return new Promise<ChangeResult>((resolve, reject) => {
        const off = asked.broker.watch((e) => {
          if (e.type !== "requested" || e.card.binds?.method !== sealed.method || e.card.binds.params !== sealed.params) return;
          off();
          resolve({ applied: false, card: e.card.id });
        });
        const decision = asked.broker.request({
          kind: "change", change: "answer-key-rotate", origin: "user", computers: [asked.computer], effect: "other", binds,
          fields: {
            title: { type: "text", text: `Replace ${NAMES[program]}'s answer key` },
            what: { type: "text", text: `Replace the key ${NAMES[program]} answers cards with on this computer? Approve only if you asked for this here.` },
            detail: { type: "rows", rows: [
              { label: "Current key", value: answerKeyFingerprint(held.alg ?? "ed25519", held.publicKey) },
              { label: "New key", value: answerKeyFingerprint(input.alg ?? "ed25519", input.publicKey) },
              { label: "Kept in", value: input.held },
            ] },
          },
          options: [{ id: "approve", kind: "approve", label: "Replace the key" }, { id: "deny", kind: "deny", label: "Keep the current key" }],
        }, { signal: ctl.signal });
        decision.then(async (d) => {
          off();
          // Settled with no card shown (the approvals stopped): the call says so; after a card, this changes nothing.
          reject(new MossRpcError(ERR.RETRY, "the replacement's card couldn't be shown: try again"));
          if (rotating === ctl) rotating = undefined;
          const record = boundCardRecord(asked.broker, d);
          // Approved, and not by this device's own signed answer (the key being replaced can't vouch for its replacement).
          if (!record || record.card.change !== "answer-key-rotate" || record.device === input.device) return;
          await table.replace(input, handOver).catch((err: unknown) => deps.log?.(`[surfaces] ${program}'s answer key wasn't replaced after its card (${err instanceof Error ? err.message.slice(0, 120) : "refused"})`));
        }, (err: unknown) => {
          off();
          reject(err);
        });
      });
    },
  };
}
