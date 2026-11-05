// String caps in UTF-16 code units. JavaScript's `.length` counts them, and the wire, the Swift mirror and stored data
// have always been held to caps counted that way. zod 4.6 counts `.min()`, `.max()` and `.length()` in code points
// instead, so a string of astral characters (emoji) would pass a cap at up to twice its size. Every string cap in the
// protocol goes through `utf16`, where a refine on `.length` decides:
// * `.max()` stays, for the JSON Schemas' `maxLength` and for zod's own `too_big` issue; it is never stricter than the
//   refine, since a string has no more code points than UTF-16 units;
// * the refine runs only when nothing failed before it, so a string that is too long by zod's count too gets one
//   issue, as before, and the checks chained after it (`.regex()`) run as they always did;
// * a minimum of 1 is the same either way (`.min(1)`); a larger one is the refine's alone, and reaches the JSON
//   Schemas as `minLength` metadata.
import { z } from "zod";

const nothingFailed = (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0;

/** A string of at most `max` UTF-16 code units, and at least `min`. */
export function utf16(max: number, min = 0): z.ZodString {
  let s = z.string();
  if (min === 1) s = s.min(1);
  s = s.max(max);
  const capped = s.refine((v) => v.length <= max && v.length >= min, {
    message: min > 1 ? `${min} to ${max} UTF-16 code units` : `at most ${max} UTF-16 code units`,
    when: nothingFailed,
  });
  return min > 1 ? capped.meta({ minLength: min }) : capped;
}
