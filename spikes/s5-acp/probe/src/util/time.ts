export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TimeoutError extends Error {}

/** Rejects with a TimeoutError when `p` takes longer than `ms`. Every ACP call goes through this. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label}: no answer after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Polls `cond` every 100 ms until it holds or `ms` passes. */
export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}
