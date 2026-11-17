// The kit's face traits and the protocol's must be the same lists (the controller's ruling of 2026-11-17): the engine
// validates a bot's pinned face against the protocol's (`BOT_FACE_SHAPES`, `BOT_FACE_COLORS`, `BOT_FACE_EYES`,
// `BOT_FACE_TEMPERS`, lane BT), which copy the kit's own (`SHAPES`, `PALETTE`'s names, `EYES`, `TEMPERS`). A change to the
// kit that isn't made in the protocol too would let MOSS offer a face the engine refuses; this fails first.
import { describe, expect, test } from "bun:test";
import * as protocol from "@waifucave/moss-protocol";
import { EYES, PALETTE, SHAPES, TEMPERS } from "../src/window/faces/living-bots";

const lists = protocol as unknown as Record<string, readonly string[] | undefined>;
const served = lists.BOT_FACE_SHAPES !== undefined;

describe("the face's traits: the kit's lists and the protocol's", () => {
  // Until lane BT's lists are on the integration branch, there is nothing to compare: said, not passed silently.
  test.skipIf(!served)("are the same, in the same order", () => {
    expect([...lists.BOT_FACE_SHAPES!]).toEqual([...SHAPES]);
    expect([...lists.BOT_FACE_COLORS!]).toEqual(PALETTE.map(([name]) => name));
    expect([...lists.BOT_FACE_EYES!]).toEqual([...EYES]);
    expect([...lists.BOT_FACE_TEMPERS!]).toEqual([...TEMPERS]);
  });
  test.skipIf(served)("wait for lane BT's lists (BOT_FACE_*) to reach the protocol", () => {
    console.warn("face-lists: the protocol has no BOT_FACE_* lists yet (lane BT); the comparison runs once it does");
  });
});
