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
  cards: "its row 56, \"the sealed page ready to answer\", is red on a GitHub runner on every attempt: the runner has no pointing device, so macOS draws classic 15 px scrollbars, the sealed button's frame (86 x 34, its page 85 x 48) shows them, and the button is 48% shown, never ready to press (measured, run 44066986653). With overlay scrollbars (`defaults write -g AppleShowScrollBars -string WhenScrolling`) the row passes. The Mac, with a trackpad, runs it at every merge batch",
  release: "needs a packaged test build signed with the Developer ID, which a GitHub runner does not have: the Mac's merge check runs it on the try build",
  arrivals: "not yet on GitHub (about 45 s of rows): the Mac's merge check runs it",
  addons: "not yet on GitHub (about 60 s of rows): the Mac's merge check runs it",
  archive: "not yet on GitHub (about 30 s of rows): the Mac's merge check runs it",
  acp: "not yet on GitHub (about 40 s of rows): the Mac's merge check runs it",
  "builder-examples": "not yet on GitHub (about 150 s of rows): the Mac's merge check runs it",
  "workshop-points": "not yet on GitHub (about 60 s of rows): the Mac's merge check runs it",
  models: "not yet on GitHub (about 90 s of rows, no app): the Mac's merge check runs it",
};
