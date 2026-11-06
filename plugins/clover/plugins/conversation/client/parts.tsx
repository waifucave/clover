// Small pieces several messages share.
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy, IconCross, IconDash, IconDots, IconPause } from "./icons";
import { S } from "./strings";
import type { ToolStatus } from "./types";

/** Copies `text` through the host's `onCopy`, or the clipboard when there is none, and says so. */
export function CopyButton({ text, label, onCopy }: { text: string; label: string; onCopy?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    if (onCopy) onCopy(text);
    else void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="cl-conv-copy" onClick={copy} aria-label={label} data-copied={copied || undefined}>
      {copied ? <IconCheck /> : <IconCopy />}
      <span className="cl-conv-copy__label">{copied ? S.copied : S.copy}</span>
    </button>
  );
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: S.toolRunning,
  waiting: S.toolWaiting,
  succeeded: S.toolSucceeded,
  failed: S.toolFailed,
  interrupted: S.toolInterrupted,
};

/** A tool's status as a shape: the mark carries the meaning, the label says it to a screen reader. */
export function StatusGlyph({ status }: { status: ToolStatus }) {
  const glyph = {
    running: <IconDots />,
    waiting: <IconPause />,
    succeeded: <IconCheck />,
    failed: <IconCross />,
    interrupted: <IconDash />,
  }[status];
  return (
    <span className="cl-conv-status" data-status={status} role="img" aria-label={STATUS_LABEL[status]}>
      {glyph}
    </span>
  );
}

export function statusLabel(status: ToolStatus): string {
  return STATUS_LABEL[status];
}
