// A bot's layout, drawn (spec §5.5): rows, columns, stacks, tabs, spots, images, text, markdown and spacers, with
// sizes and `hideBelow` for narrow windows. The core hands it over checked and resolved (bridge.ts `LayoutView`), and
// the runtime draws it as the tab's part, so its `{ spot }` nodes resolve as that part's spots. Data only: no events
// but the tabs' own switching, no scripts, no outside URLs. Markdown is drawn as elements, never as HTML, and its
// links show as text.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { LayoutView } from "./bridge";

type Axis = "row" | "column" | "none";

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 10_000 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** A node's own box, as a child of a parent laid out along `axis`. */
function boxStyle(n: LayoutView, axis: Axis): CSSProperties {
  const s: CSSProperties = {};
  if (n.size !== undefined) {
    const fr = /^(\d+(?:\.\d+)?)fr$/.exec(n.size);
    if (fr !== null) s.flex = `${fr[1]} 1 0`;
    else if (axis === "none") {
      s.width = n.size;
    } else s.flex = `${n.grow ?? 0} 0 ${n.size}`;
  } else if (n.grow !== undefined) {
    s.flexGrow = n.grow;
  }
  if (n.min !== undefined) {
    if (axis === "column") s.minHeight = n.min;
    else s.minWidth = n.min;
  }
  if (n.max !== undefined) {
    if (axis === "column") s.maxHeight = n.max;
    else s.maxWidth = n.max;
  }
  if (n.padding !== undefined) s.padding = n.padding;
  if (n.gap !== undefined) s.gap = n.gap;
  // A child of a row or column may shrink below its content, as the panes of an app do.
  if (axis !== "none") {
    if (axis === "row") s.minWidth ??= 0;
    else s.minHeight ??= 0;
  }
  return s;
}

const ALIGN: Record<NonNullable<LayoutView["align"]>, CSSProperties["alignItems"]> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };

interface DrawProps {
  node: LayoutView;
  axis: Axis;
  width: number;
  renderSpot: (spot: string, key: string | undefined) => ReactNode;
  path: string;
}

function Tabs({ node, axis, width, renderSpot, path }: DrawProps & { node: Extract<LayoutView, { kind: "tabs" }> }) {
  const [at, setAt] = useState(0);
  const current = node.tabs[Math.min(at, node.tabs.length - 1)];
  return (
    <div className={node.className} data-clover-layout="tabs" style={{ ...boxStyle(node, axis), display: "flex", flexDirection: "column" }}>
      <div role="tablist" data-clover-layout="tablist">
        {node.tabs.map((t, i) => (
          <button key={i} type="button" role="tab" aria-selected={i === at} data-clover-layout="tab" onClick={() => setAt(i)}>{t.title}</button>
        ))}
      </div>
      <div role="tabpanel" data-clover-layout="tabpanel" style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {current !== undefined ? <Draw node={current.node} axis="column" width={width} renderSpot={renderSpot} path={`${path}.${at}`} /> : null}
      </div>
    </div>
  );
}

function Draw(props: DrawProps): ReactNode {
  const { node, axis, width, renderSpot, path } = props;
  if (node.hideBelow !== undefined && width < node.hideBelow) return null;
  const box = boxStyle(node, axis);
  switch (node.kind) {
    case "row":
    case "column": {
      const dir = node.kind as "row" | "column";
      return (
        <div className={node.className} data-clover-layout={dir} style={{ ...box, display: "flex", flexDirection: dir, ...(node.align !== undefined ? { alignItems: ALIGN[node.align] } : {}) }}>
          {node.children.map((c, i) => <Draw key={i} node={c} axis={dir} width={width} renderSpot={renderSpot} path={`${path}.${i}`} />)}
        </div>
      );
    }
    case "stack":
      return (
        <div className={node.className} data-clover-layout="stack" style={{ ...box, display: "grid", ...(node.align !== undefined ? { alignItems: ALIGN[node.align], justifyItems: ALIGN[node.align] } : {}) }}>
          {node.children.map((c, i) => (
            <div key={i} style={{ gridArea: "1 / 1", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Draw node={c} axis="column" width={width} renderSpot={renderSpot} path={`${path}.${i}`} />
            </div>
          ))}
        </div>
      );
    case "tabs":
      return <Tabs {...props} node={node} />;
    case "spot":
      return (
        <div className={node.className} data-clover-layout="spot" style={{ ...box, display: "flex", flexDirection: "column" }}>
          {renderSpot(node.spot, node.key)}
        </div>
      );
    case "image":
      return <img className={node.className} data-clover-layout="image" src={node.src} alt="" draggable={false} style={{ ...box, objectFit: "contain", maxWidth: box.maxWidth ?? "100%" }} />;
    case "text":
      return <p className={node.className} data-clover-layout="text" style={{ ...box, margin: 0 }}>{node.text}</p>;
    case "markdown":
      return <div className={node.className} data-clover-layout="markdown" style={box}>{markdown(node.markdown)}</div>;
    case "spacer":
      return <div className={node.className} data-clover-layout="spacer" aria-hidden="true" style={{ flex: "1 1 auto", ...box }} />;
  }
}

/** A layout, drawn: the tab's root is a column filling the part. */
export function LayoutRoot({ layout, renderSpot }: { layout: LayoutView; renderSpot: DrawProps["renderSpot"] }) {
  const width = useWindowWidth();
  return (
    <div data-clover-layout="root" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Draw node={layout} axis="column" width={width} renderSpot={renderSpot} path="0" />
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Markdown, as elements: headings, paragraphs, lists, quotes, code, emphasis; links as their text
// -------------------------------------------------------------------------------------------------

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // `code`, **strong**, *em* or _em_, [text](url) (the text only), in order of appearance.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]*\]\([^)]*\))/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const t = m[0];
    const k = `${key}.${i++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>);
    else out.push(t.slice(1, t.indexOf("](")));
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Markdown's common blocks as React elements. */
export function markdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(<pre key={key}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = Math.min(6, heading[1]!.length);
      const H = `h${level}` as "h1";
      out.push(<H key={key}>{inline(heading[2]!, key)}</H>);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i]!)) items.push(lines[i++]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ""));
      const L = ordered ? "ol" : "ul";
      out.push(<L key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}.${j}`)}</li>)}</L>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(<blockquote key={key}>{inline(body.join(" "), key)}</blockquote>);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return out;
}
