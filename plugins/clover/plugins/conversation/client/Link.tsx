// Every link the conversation draws goes through here (review item 3): one rule for what may open,
// footnotes that stay inside the view, and a middle-click that never navigates on its own.
import type { MouseEvent, ReactNode } from "react";
import { fragmentOf, safeLink, scrollToFragment } from "./links";

export interface LinkProps {
  href: string | undefined;
  onOpenLink?: (url: string) => void;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Link({ href, onOpenLink, className, title, children }: LinkProps) {
  const fragment = fragmentOf(href);
  if (fragment !== undefined) {
    return (
      <a
        className={className}
        href={`#${fragment}`}
        onClick={(e) => {
          e.preventDefault();
          scrollToFragment(e.currentTarget, fragment);
        }}
        onAuxClick={(e) => e.preventDefault()}
      >
        {children}
      </a>
    );
  }
  const url = safeLink(href);
  if (url === undefined) {
    return (
      <span className={className} data-blocked="">
        {children}
      </span>
    );
  }
  const open = (e: MouseEvent) => {
    e.preventDefault();
    onOpenLink?.(url);
  };
  return (
    <a
      className={className}
      href={url}
      title={title}
      rel="noreferrer"
      onClick={open}
      onAuxClick={(e) => {
        e.preventDefault();
        if (e.button === 1) onOpenLink?.(url);
      }}
    >
      {children}
    </a>
  );
}
