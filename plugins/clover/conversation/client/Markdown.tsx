// The bot's Markdown. Raw HTML shows as the text it is, never as markup; `javascript:` and other
// unsafe link targets are dropped (react-markdown's default URL transform); links and images go to
// the host's `onOpenLink`, so nothing here ever navigates or loads a remote image.
import { memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./parts";
import { S } from "./strings";

/** The text of a hast node, for copying a code block as written. */
interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function languageOf(node: HastNode | undefined): string | undefined {
  const cls = node?.properties?.className;
  const list = Array.isArray(cls) ? cls : typeof cls === "string" ? [cls] : [];
  for (const c of list) {
    if (typeof c === "string" && c.startsWith("language-")) return c.slice("language-".length);
  }
  return undefined;
}

export interface MarkdownProps {
  text: string;
  onOpenLink?: (url: string) => void;
  onCopy?: (text: string) => void;
}

function components(onOpenLink: MarkdownProps["onOpenLink"], onCopy: MarkdownProps["onCopy"]): Components {
  const open = (url: string | undefined) => (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (url) onOpenLink?.(url);
  };
  return {
    a: ({ href, children }) => (
      <a className="cl-conv-md__link" href={href} onClick={open(href)}>
        {children}
      </a>
    ),
    img: ({ src, alt }) => {
      const url = typeof src === "string" ? src : undefined;
      return (
        <a className="cl-conv-md__image-link" href={url} onClick={open(url)}>
          {S.imageLink(alt ?? "")}
        </a>
      );
    },
    pre: ({ node, children }) => {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.type === "element");
      const language = languageOf(code);
      return (
        <div className="cl-conv-code">
          <div className="cl-conv-code__bar">
            <span className="cl-conv-code__lang">{language ?? ""}</span>
            <CopyButton text={hastText(code).replace(/\n$/, "")} label={S.copyCode} onCopy={onCopy} />
          </div>
          <pre className="cl-conv-code__pre">{children as ReactNode}</pre>
        </div>
      );
    },
    table: ({ children }) => (
      <div className="cl-conv-md__table">
        <table>{children}</table>
      </div>
    ),
  };
}

function MarkdownTextImpl({ text, onOpenLink, onCopy }: MarkdownProps) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components(onOpenLink, onCopy)}>
      {text}
    </Markdown>
  );
}

/** Memoized on its text, so a finished message never re-parses while another one streams. */
export const MarkdownText = memo(MarkdownTextImpl);
