// Contract: ProgramAnswerKeys (spec revision 19, §5.5 "Only sealed buttons answer", §8.1; ruling C, item 91). Owner:
// lane RT, over lane H's device registry (`DeviceRecord.answerKeys`).
//
// One answer key per (device, program): MOSS, MOSS Code and the background host each hold their own in their own protected
// storage and register it. The program is the registering connection's signed identity (its surface on Windows and Linux,
// `SurfaceDoor.programOf`), never a claim in the call. An answer's proof names its program, and verifies only against that
// program's key: no press is forwarded from one program to another.
//
// What the contract promises:
// * `register` takes a key only with the key's own signature over `programAnswerKeyStatement` (device, program, key, how
//   it is held, its algorithm); the first key of a program applies at once, and replacing one answers `card` (a sealed
//   card the user answers, as `device.answerKey.set`'s replacement does).
// * `verify` checks a signature over `programCardAnswerSigningInput` with the named program's key alone; false for an
//   unknown device or program, another program's key, other bytes, or a revoked device.
// * Today's single key per device is the `code` program's (`legacyKey`): MOSS Code is today's app.
import type { AnswerKeyAlg, AnswerKeyHolder, Program } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

export interface ProgramKey {
  program: Program;
  publicKey: string;
  held: AnswerKeyHolder;
  alg?: AnswerKeyAlg;
}

export type ProgramKeyResult = { applied: true } | { applied: false; card: true };

export interface ProgramAnswerKeys {
  /** A program's registration from its connection (`program` from the connection, never the call). */
  register(input: { device: string; program: Program; publicKey: string; held: AnswerKeyHolder; alg?: AnswerKeyAlg; signature: string }): Promise<ProgramKeyResult>;
  keyOf(device: string, program: Program): ProgramKey | undefined;
  list(device: string): ProgramKey[];
  /** Whether `signature` is `program`'s answer signature over `data` on `device`. */
  verify(device: string, program: Program, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
  /** The device was revoked: none of its programs' keys counts. */
  revoked(device: string): void;
  watch(fn: (change: { device: string; key: ProgramKey }) => void): Unsubscribe;
}
