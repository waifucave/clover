// The live picture's fixture frame: the fake browser page (fixtures.ts) rasterised to a PNG, for the UI test and the
// renders.
import { PAGE_SVG } from "./fake-engine/fixtures";

export async function pagePng(): Promise<Uint8Array> {
  const { Resvg } = await import("@resvg/resvg-js");
  return new Uint8Array(new Resvg(PAGE_SVG, { fitTo: { mode: "width", value: 1280 } }).render().asPng());
}
