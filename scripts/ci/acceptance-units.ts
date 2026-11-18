// The acceptance units GitHub does not run, and why. The units GitHub DOES run are the matrix in `.github/workflows/ci.yml`
// (job `acceptance`, `strategy.matrix.unit`): that one line is the only place to add a unit to the lane gate. Every unit of
// scripts/acceptance/shards.ts is in that line or here, never neither (scripts/ci-changes.test.ts), so a lane that adds a
// unit meets the question when its tests run, not after a row that never ran on a runner has been merged.
//
// An entry may name a unit before its lane has merged (`release`): the test checks only that no unit is in both places and
// that every unit that exists is in one.
export const NOT_ON_GITHUB: Readonly<Record<string, string>> = {
  cold: "measures the cold start's deadline, alone on the machine: the Mac's merge check runs it",
  idle: "measures idle CPU, alone on the machine: the Mac's merge check runs it",
  "browser-host": "on a GitHub runner, with the sealed pages fitting their frame (lane RT), a press on the background host's island is still refused now and then as covered: the sealed page sends no fresh visibility report within the 400 ms the press allows (\"fresh report none in time after 402 ms\") while the runner's main process is busy reloading layers, though earlier presses in the same run were read uncovered in 2 to 12 ms (run 44111651415); the Mac's merge check runs it",
  "surface-copy-host": "on a GitHub runner, with the sealed pages fitting their frame (lane RT), a press on the background host's island is still refused now and then as covered: the sealed page sends no fresh visibility report within the 400 ms the press allows (\"fresh report none in time after 402 ms\") while the runner's main process is busy reloading layers, though earlier presses in the same run were read uncovered in 2 to 12 ms (run 44111651415); the Mac's merge check runs it",
  release: "needs a packaged test build signed with the Developer ID, which a GitHub runner does not have: the Mac's merge check runs it on the try build",
};
