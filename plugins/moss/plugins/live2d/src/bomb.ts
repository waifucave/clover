// The archive-bomb check, run the same way in Bun (the tests) and in Chromium (the gallery job), since engines differ
// (Chromium's DecompressionStream inflates a written chunk whole before its reader sees anything). A deflate stream of
// many megabytes of zeros goes through `inflateCapped` with a 1 MiB cap, and the check reports how much compressed
// data had been pushed when the cap tripped: a slice or two, never the whole stream.

import { deflateSync } from "fflate";
import { INFLATE_SLICE, inflateCapped } from "./zip";
import { Live2dRefusal } from "./validate";

export interface BombCheck {
  /** The zeros the deflate stream holds, and its compressed size. */
  inflatesTo: number;
  compressed: number;
  cap: number;
  /** Compressed bytes pushed into the inflater before the cap tripped. */
  writtenBeforeRefusal: number;
  largestWrite: number;
  refused: boolean;
  detail: string;
  ms: number;
}

export async function archiveBombCheck(inflatesTo = 32 * 1024 * 1024, cap = 1024 * 1024): Promise<BombCheck> {
  const data = deflateSync(new Uint8Array(inflatesTo), { level: 9 });
  let pushed = 0;
  let largest = 0;
  let atRefusal = -1;
  const started = performance.now();
  let detail = "inflated whole";
  let refused = false;
  try {
    await inflateCapped(data, cap, "the bomb", {
      onPush: (bytes) => {
        pushed += bytes;
        largest = Math.max(largest, bytes);
      },
    });
  } catch (error) {
    refused = error instanceof Live2dRefusal && error.code === "too-large";
    detail = error instanceof Error ? error.message : String(error);
    atRefusal = pushed;
  }
  return { inflatesTo, compressed: data.length, cap, writtenBeforeRefusal: atRefusal, largestWrite: largest, refused, detail, ms: Math.round(performance.now() - started) };
}

/** What the check must show, in either engine: refused, no push over a slice, and only a few slices in. */
export function bombCheckProblems(check: BombCheck): string[] {
  const problems: string[] = [];
  if (!check.refused) problems.push(`not refused: ${check.detail}`);
  if (check.largestWrite > INFLATE_SLICE) problems.push(`a push of ${check.largestWrite} bytes, over the ${INFLATE_SLICE}-byte slice`);
  if (check.writtenBeforeRefusal > 8 * INFLATE_SLICE) problems.push(`${check.writtenBeforeRefusal} compressed bytes pushed before the cap tripped (of ${check.compressed})`);
  return problems;
}
