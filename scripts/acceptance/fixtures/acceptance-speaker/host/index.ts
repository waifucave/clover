// The acceptance run's speaker: any plugin holding `avatar.control.all` may move any bot's figure. `speak` sends the avatar
// cue API's speech cue for Alpha: twelve levels, 20 ms apart, the first stamped 1.5 s ahead of the clock (epoch ms), with
// distinctive loudness so the run can tell them from any other speech.
type Cue = (cue: unknown, opts?: { bot?: string }) => Promise<unknown>;
let cue: Cue | undefined;

export async function start(api: { avatar: { cue: Cue } }): Promise<void> {
  cue = api.avatar.cue;
}
export async function stop(): Promise<void> {}

export async function speak(): Promise<{ text: string }> {
  if (cue === undefined) return { text: "speak: no api" };
  const t0 = Date.now() + 1500;
  const frames = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 20, rms: 0.31 + i / 100, centroid: 1200 }));
  try {
    const answer = await cue({ type: "speech", frames }, { bot: "alpha" });
    return { text: `speak: ${JSON.stringify({ answer, t0, n: frames.length, last: frames[frames.length - 1]!.t })}` };
  } catch (err) {
    return { text: `speak: threw ${err instanceof Error ? err.message : String(err)}` };
  }
}
