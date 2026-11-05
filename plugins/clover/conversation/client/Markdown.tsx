// The bot's Markdown. Raw HTML shows as the text it is, never as markup. Every link and image goes
// through `Link` (`links.ts`): only absolute http, https and mailto targets reach the host's
// `onOpenLink`, footnotes scroll inside the view, and an image is a link that never loads.
import { memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "./Link";
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
  return {
    a: ({ href, children }) => (
      <Link className="cl-conv-md__link" href={href} onOpenLink={onOpenLink}>
        {children}
      </Link>
    ),
    img: ({ src, alt }) => (
      <Link className="cl-conv-md__image-link" href={typeof src === "string" ? src : undefined} onOpenLink={onOpenLink}>
        {S.imageLink(alt ?? "")}
      </Link>
    ),
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
