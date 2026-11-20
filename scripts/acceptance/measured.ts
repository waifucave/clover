// Rows whose pass bar is a measured rate or percentage. On a shared CI runner such a number says nothing about the app (the
// machine's other tenants move it by multiples), so ci.yml sets MOSS_ACCEPT_MEASURE=mac-only and the row says so instead of
// measuring: its detail starts with the marker below, and the unit's verdict (scripts/ci/acceptance-unit.ts) lists it as
// "measured on the Mac only" rather than as a pass. Only the rows named here may say it. The Mac's merge check measures them
// all, with the variable unset.
export const MEASURED_ON_MAC_ONLY = "MEASURED ON THE MAC ONLY";

/** The rows (by the start of their names) that may be left to the Mac, with the reason the table prints. */
export const MEASURED_ROWS: readonly { prefix: string; reason: string }[] = [
  {
    prefix: "window: an idle app with MOSS's tab open stays cheap",
    reason: "its bar is the main process's CPU share and the windows' messages a second over 15 s; a shared runner's load moves both several times over (the run that failed it counted 86 messages/s against a limit of 20 with 1.0/s on its own channels)",
  },
];

/** Whether this run leaves the measured rows to the Mac. */
export const measuredOnMacOnly = (): boolean => process.env.MOSS_ACCEPT_MEASURE === "mac-only";
