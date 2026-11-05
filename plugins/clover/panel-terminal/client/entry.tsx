// The terminal on the runtime: the `panel` entry keyed `terminal`, for coding sessions only (`when.session: "coding"`).
// It opens a shell on the computer that holds the session's folder, in that folder, through the plugin API's
// `terminal` (lane J's PTY; B's `TerminalApi`), shows each terminal's output, and sends what the user types. A paste
// goes whole, marked as one (`paste: true`), so the core brackets it and asks before several lines run. Its tabs sit in
// the panel's header row.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TerminalPanel, TerminalTabs } from "./TerminalPanel";
import { usePluginApi } from "./sdk";
import type { TerminalChunk, TerminalTab } from "./types";

export interface TerminalEntryProps {
  session?: string;
  /** The panel's header row, for the tabs (the clover layer's header slot). */
  header?: HTMLElement | null;
}

/** The terminal's size on open; the view resizes it once it is laid out. */
const COLS = 100;
const ROWS = 30;

function Header({ slot, children }: { slot: HTMLElement | null | undefined; children: ReactNode }) {
  return slot ? createPortal(<div className="cl-panel__head-own">{children}</div>, slot) : null;
}

export function TerminalEntry({ props }: { props: TerminalEntryProps }) {
  const api = usePluginApi();
  const term = api.terminal;
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [chunks, setChunks] = useState<Record<string, TerminalChunk[]>>({});
  const stops = useRef(new Map<string, () => void>());
  const counter = useRef(0);

  const open = async () => {
    if (!term || !props.session || !api.conversation?.get) return;
    const session = await api.conversation.get(props.session);
    const { terminalId } = await term.open({ computer: session.computer, ...(session.root ? { cwd: session.root } : {}), session: props.session, cols: COLS, rows: ROWS });
    counter.current += 1;
    setTabs((t) => [...t, { id: terminalId, title: `${session.computer} ${counter.current}` }]);
    setActive(terminalId);
    stops.current.set(
      terminalId,
      term.onData(terminalId, (data, exited) => {
        if (data) setChunks((c) => ({ ...c, [terminalId]: [...(c[terminalId] ?? []), { text: data }] }));
        if (exited) setTabs((t) => t.map((x) => (x.id === terminalId ? { ...x, exited: { code: exited.code ?? 0 } } : x)));
      }),
    );
  };

  useEffect(() => {
    void open();
    const current = stops.current;
    return () => {
      for (const stop of current.values()) stop();
      current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, props.session]);

  const close = (id: string) => {
    stops.current.get(id)?.();
    stops.current.delete(id);
    void term?.close(id);
    setTabs((t) => {
      const rest = t.filter((x) => x.id !== id);
      if (active === id) setActive(rest[rest.length - 1]?.id);
      return rest;
    });
  };

  if (!active) return null;
  return (
    <>
      <Header slot={props.header}>
        <TerminalTabs tabs={tabs} active={active} onSelect={setActive} onNew={() => void open()} onClose={close} />
      </Header>
      <TerminalPanel
        tabs={tabs}
        active={active}
        chunks={chunks[active] ?? []}
        onInput={(data) => void term?.write(active, data)}
        onPaste={(text) => void term?.write(active, text, { paste: true })}
      />
    </>
  );
}
