// Her room sizes itself by her tab's width, the window's less the window's own sidebar beside it (open or folded): the
// same steps her layout's container queries take on the scene, so the room and the layout agree on wide, mid and narrow.
import { describe, expect, test } from "bun:test";
import { roomSize, SIDEBAR_FOLDED_PX, SIDEBAR_OPEN_PX, tabWidth } from "../../client/room-size";

describe("her room's size", () => {
  test("the tab is the window less the sidebar, open by default until the window says", () => {
    expect(tabWidth(1280, undefined)).toBe(1280 - SIDEBAR_OPEN_PX);
    expect(tabWidth(1280, { sidebar: { collapsed: false, side: "bots" } })).toBe(1280 - SIDEBAR_OPEN_PX);
    expect(tabWidth(1280, { sidebar: { collapsed: true, side: "bots" } })).toBe(1280 - SIDEBAR_FOLDED_PX);
  });

  test("a 1280 window is her mid room with the sidebar open and her wide room with it folded; a 700 one is narrow either way", () => {
    expect(roomSize(tabWidth(1280, { sidebar: { collapsed: false, side: "bots" } }))).toBe("mid");
    expect(roomSize(tabWidth(1280, { sidebar: { collapsed: true, side: "bots" } }))).toBe("wide");
    expect(roomSize(tabWidth(700, { sidebar: { collapsed: false, side: "bots" } }))).toBe("narrow");
    expect(roomSize(tabWidth(700, { sidebar: { collapsed: true, side: "bots" } }))).toBe("narrow");
  });

  test("the steps are her layout's: 900 and below narrow, to 1100 mid, wider wide", () => {
    expect([900, 901, 1100, 1101].map(roomSize)).toEqual(["narrow", "mid", "mid", "wide"]);
  });
});
