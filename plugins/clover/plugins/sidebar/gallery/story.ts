import type { ReactNode } from "react";

/** One gallery entry: a component in one state. The gallery draws it in a frame `width` wide (880 by
 *  default) and `height` tall (its own height when absent), once per theme. */
export interface Story {
  /** `<part>/<state>`, also the screenshot's file name. */
  id: string;
  title: string;
  /** What to look at. */
  notes?: string;
  width?: number;
  height?: number;
  render: () => ReactNode;
}
