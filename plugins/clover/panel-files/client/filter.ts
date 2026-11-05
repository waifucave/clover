// Which entries a filter keeps: a match on the name, plus every folder on the way to a match, among
// the folders already listed. Case does not matter.
import type { FileEntry } from "./types";

export function visiblePaths(root: string, listing: Readonly<Record<string, readonly FileEntry[]>>, filter: string): Set<string> | undefined {
  const query = filter.trim().toLowerCase();
  if (query.length === 0 || query.startsWith("?")) return undefined;
  const keep = new Set<string>();
  const walk = (folder: string): boolean => {
    let any = false;
    for (const entry of listing[folder] ?? []) {
      const hit = entry.name.toLowerCase().includes(query);
      const below = entry.type === "dir" ? walk(entry.path) : false;
      if (hit || below) {
        keep.add(entry.path);
        any = true;
      }
    }
    return any;
  };
  walk(root);
  return keep;
}
