// Small hooks for reading the plugin API and the core: a value loaded once (and again when its inputs change), and a
// list kept live by a watch. Each part keeps its own copy, so parts stay independent packages.
import { useEffect, useState } from "react";

/** Loads a value, and again whenever `deps` change; `undefined` until it arrives. A failed load stays `undefined`. */
export function useLoad<T>(load: (() => Promise<T>) | undefined, deps: readonly unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let live = true;
    load?.().then(
      (v) => live && setValue(v),
      () => live && setValue(undefined),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** A list read once, then kept current by a watch that hands over one changed item at a time. */
export function useLiveList<T>(
  load: (() => Promise<T[]>) | undefined,
  watch: ((listener: (item: T) => void, onRemoved?: (id: string) => void) => () => void) | undefined,
  same: (a: T, b: T) => boolean,
  deps: readonly unknown[] = [],
  /** The id an item goes by: with it, the watch's removals (`onRemoved`) drop the item from the list. */
  idOf?: (item: T) => string,
): T[] | undefined {
  const [items, setItems] = useState<T[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    load?.().then((v) => live && setItems(v), () => live && setItems([]));
    const stop = watch?.((item) => setItems((list) => (list ? (list.some((x) => same(x, item)) ? list.map((x) => (same(x, item) ? item : x)) : [...list, item]) : list)),
      idOf === undefined ? undefined : (id) => setItems((list) => list?.filter((x) => idOf(x) !== id)),
    );
    return () => {
      live = false;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return items;
}
