// Reads `usage.read` for a view, and reads again whenever `usage.watch` says new rows arrived. A read that answers
// after a newer one started is dropped, so a slow answer never overwrites a fresh one.

import { useEffect, useRef, useState } from "react";
import type { UsageApi } from "../model/usage";

export interface UsageState<T> {
  data?: T;
  error?: boolean;
}

export function useUsageRead<T>(api: UsageApi, read: (api: UsageApi) => Promise<T>, key: string): UsageState<T> {
  const [state, setState] = useState<UsageState<T>>({});
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let alive = true;
    let latest = 0;
    const load = () => {
      const n = ++latest;
      readRef.current(api).then(
        (data) => alive && n === latest && setState({ data }),
        () => alive && n === latest && setState((s) => ({ data: s.data, error: true })),
      );
    };
    load();
    const stop = api.watch(load);
    return () => {
      alive = false;
      stop();
    };
  }, [api, key]);
  return state;
}
