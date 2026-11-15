// The narrator's child: the same ask as its parent's `narrate`, with no `voices.use` of its own.
type Api = { voices: { providers(): Promise<unknown[]> } };
let api: Api | undefined;
export function start(a: Api): void {
  api = a;
}
export const nosy = async (): Promise<Record<string, unknown>> => {
  if (api === undefined) return { error: "not started" };
  try {
    // The providers' list first, as its parent asks: the plain call the core refuses without voices.use.
    await api.voices.providers();
    return { error: "the core let it through" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
