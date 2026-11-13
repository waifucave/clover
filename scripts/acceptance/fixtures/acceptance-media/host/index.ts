// The acceptance media plugin's host half: what its page asks of it with `host.call("statToken", { token })`. The page holds only
// a token its file picker handed it; the host half uses it as the path of `files.stat`, which the core resolves for this
// plugin alone (a token held by another plugin answers not found), and of `files.path`, the real path a program of its own
// would take (host half only). It answers the size and the real path's last part (never the path itself), or why it couldn't.
interface FilesApi { stat(path: string): Promise<{ size: number } | null>; path(path: string): Promise<string> }
let api: { files?: FilesApi } | undefined;

export async function start(a: unknown): Promise<void> {
  api = a as { files?: FilesApi };
}

export const ui = {
  statToken: async (args: unknown): Promise<{ size: number | null; file?: string } | { note: string }> => {
    const token = (args as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || !/^grant:[0-9a-f-]{36}$/.test(token)) return { note: "not a file token" };
    if (api?.files === undefined) return { note: "no files API" };
    try {
      const st = await api.files.stat(token);
      const real = await api.files.path(token);
      return { size: st === null ? null : st.size, file: real.split("/").pop() ?? "" };
    } catch (err) {
      return { note: String((err as Error)?.message ?? err).slice(0, 160) };
    }
  },
};

export async function stop(): Promise<void> {}
