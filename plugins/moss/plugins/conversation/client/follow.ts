// Following the bottom: the view keeps up with new output only while the reader is already at the
// bottom; a reader who scrolled up keeps their place and gets a "Jump to latest" pill instead.

/** How close to the bottom still counts as at the bottom, in CSS pixels. */
export const FOLLOW_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

export function isAtBottom(m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/** After content changed: scroll to the bottom when following, otherwise say there is more below. */
export function afterContentChange(following: boolean, m: ScrollMetrics): { scrollToBottom: boolean; showJump: boolean } {
  if (following) return { scrollToBottom: true, showJump: false };
  return { scrollToBottom: false, showJump: !isAtBottom(m) };
}
