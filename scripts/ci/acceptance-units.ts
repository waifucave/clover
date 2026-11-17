// The acceptance units GitHub does not run, and why. The units GitHub DOES run are the matrix in `.github/workflows/ci.yml`
// (job `acceptance`, `strategy.matrix.unit`): that one line is the only place to add a unit to the lane gate. Every unit of
// scripts/acceptance/shards.ts is in that line or here, never neither (scripts/ci-changes.test.ts), so a lane that adds a
// unit meets the question when its tests run, not after a row that never ran on a runner has been merged.
//
// An entry may name a unit before its lane has merged (`release`): the test checks only that no unit is in both places and
// that every unit that exists is in one.
export const NOT_ON_GITHUB: Readonly<Record<string, string>> = {
  stage: "measures a card's timing and a streamed reply's cost, alone on the machine: a shared runner's load decides the numbers (MOSS_ACCEPT_MEASURE=mac-only); the Mac's merge check runs it",
  "tab-flash": "measures the tab flash, alone on the machine: the Mac's merge check runs it",
  cold: "measures the cold start's deadline, alone on the machine: the Mac's merge check runs it",
  idle: "measures idle CPU, alone on the machine: the Mac's merge check runs it",
  "browser-host": "presses its cards on the background host's island, and on a GitHub runner the island's sealed buttons never say ready: the runner has no pointing device, so macOS draws classic 15 px scrollbars that take a sealed button page's room, the button reads about half shown and the host's fallback card takes the card (runs 44089266815, 44101140442; as for `cards`). It moves to the matrix with `cards` when the sealed pages' fix lands (lane RT); the Mac's merge check runs it",
  release: "needs a packaged test build signed with the Developer ID, which a GitHub runner does not have: the Mac's merge check runs it on the try build",
  arrivals: "not yet on GitHub (about 45 s of rows): the Mac's merge check runs it",
  addons: "not yet on GitHub (about 60 s of rows): the Mac's merge check runs it",
  archive: "not yet on GitHub (about 30 s of rows): the Mac's merge check runs it",
  acp: "not yet on GitHub (about 40 s of rows): the Mac's merge check runs it",
  "builder-examples": "not yet on GitHub (about 150 s of rows): the Mac's merge check runs it",
  "workshop-points": "not yet on GitHub (about 60 s of rows): the Mac's merge check runs it",
  models: "not yet on GitHub (about 90 s of rows, no app): the Mac's merge check runs it",
};
