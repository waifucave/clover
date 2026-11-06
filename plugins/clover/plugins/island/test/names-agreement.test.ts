// The island and the manifest check fold names the same way (lane B's `foldTitle`), so a title or a plugin name the
// manifest refuses is one the island refuses, and the other way round.
import { describe, expect, test } from "bun:test";
import { foldTitle, reservedTitles } from "@waifucave/clover-plugin-sdk";
import { isReservedPluginName, isReservedTab } from "../src/model/tabs";
import { nameSkeleton, readsAs } from "../src/model/names";

const NAMES = [
  "Needs you", "Needs​ you", "Needs​you", "Needsyou", "Needs-you", "N­eeds you", "‮Needs you",
  "Needs yоu", "Nееds you", "Νeeds you", "ɴᴇᴇᴅꜱ ʏᴏᴜ", "𝐍𝐞𝐞𝐝𝐬 𝐲𝐨𝐮", "Ｎｅｅｄｓ　ｙｏｕ", "Nééds yoü",
  "Needsㅤyou", "NEEDS YOU", "Needs y0u", "Needs you️", "Needs", "Needs you now", "Feeds you", "Devices", "Usage",
  "Clover", "CLOVER", "Clоver", "C1over", "dover", "Homelab",
];

const PAIRS: [string, string][] = [
  ["Iris", "iris"], ["ILSE", "ilse"], ["Ivy", "lvy"], ["Luna", "Ꮮuna"], ["Luna", "Lu​na"], ["Luna", "Lúna"],
  ["modern", "modem"], ["vvolf", "wolf"], ["clover", "dover"], ["Alpha", "Аlpha"], ["Alpha", "Αⅼpha"],
  ["Luna", "Lena"], ["Alpha", "Alpha 2"], ["Home", "Homes"],
];

describe("the island's names agree with the manifest check's", () => {
  test("the island's skeleton is foldTitle", () => {
    for (const name of NAMES) expect(nameSkeleton(name)).toBe(foldTitle(name));
    for (const [a, b] of PAIRS) expect([a, b, readsAs(a, b)]).toEqual([a, b, foldTitle(a) === foldTitle(b)]);
  });

  test("a title the manifest reserves is one the island refuses, and only those", () => {
    const reserved = reservedTitles();
    for (const title of NAMES) expect([title, isReservedTab({ id: "x", title })]).toEqual([title, reserved.has(foldTitle(title))]);
  });

  test("the lookalikes the island's own fold caught, B's catches too", () => {
    for (const [a, b] of PAIRS.slice(0, 11)) expect([a, b, readsAs(a, b)]).toEqual([a, b, true]);
    for (const [a, b] of PAIRS.slice(11)) expect([a, b, readsAs(a, b)]).toEqual([a, b, false]);
    for (const name of ["Clover", "CLOVER", "Clоver", "C1over", "Needs​ you"]) expect([name, isReservedPluginName(name)]).toEqual([name, true]);
    expect(isReservedPluginName("Homelab")).toBe(false);
  });
});
