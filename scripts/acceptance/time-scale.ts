// One scale for every wait in the acceptance run. A hosted CI runner is several times slower than a developer's Mac and its
// speed moves from run to run, so a wait that is tight on a runner is not a bug of the app: ci.yml sets MOSS_ACCEPT_TIME_SCALE
// (3 there) and each "not within N s" wait takes N times that. Unset, or anything but a number from 1 up to 10, it is 1: a
// local run waits exactly as long as its steps say. Measured numbers (an idle cost, a count of ticks) are not waits and are
// not scaled by this; they have their own switches.
const parsed = Number(process.env.MOSS_ACCEPT_TIME_SCALE ?? "1");

/** The scale: 1 on a Mac, what ci.yml sets on a runner. */
export const TIME_SCALE: number = Number.isFinite(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 1;

/** A wait of `ms` milliseconds, as long as this run's scale makes it. */
export const scaled = (ms: number): number => Math.round(ms * TIME_SCALE);
