// The acceptance run's third-party window fixture: one component for each spot it fills, each drawing `data-acceptance-window`
// attributes the run reads, and a page that tries the UI SDK's hooks and writes what each gave. TSX importing React and the
// UI SDK only; no react in the folder (each layer's import map serves them).
import { useEffect, useRef, useState } from "react";
import {
  useApprovals, useComposerHost, useDrag, useKept, useMenu, useOpen, useQuestions, useSurface, useUserSend, useViewFrame,
} from "@waifucave/clover-plugin-sdk/ui";

type Item = { id?: string; kind?: string; text?: string; at?: number; name?: string; calls?: unknown[]; result?: unknown };

/** The `composer.action` button: pressed, it counts the press. */
export function ComposerButton({ props }: { props: { bot?: unknown; session?: string } }) {
  const [pressed, setPressed] = useState(0);
  return (
    <button type="button" data-acceptance-window="composer" data-pressed={pressed} data-session={props.session ?? ""} onClick={() => setPressed((n) => n + 1)}>
      Acceptance action
    </button>
  );
}

/** The `conversation.message` cell keyed `user`: the user's own message drawn this plugin's way. */
export function UserMessage({ props }: { props: { item: Item } }) {
  return (
    <div data-acceptance-window="user-message" data-text={props.item.text ?? ""} data-kind={props.item.kind ?? ""}>
      {props.item.text ?? ""}
    </div>
  );
}

/** The `conversation.message.extra` add-on under each message. */
export function MessageExtra({ props }: { props: { item: Item } }) {
  return (
    <div data-acceptance-window="extra" data-kind={props.item.kind ?? ""} data-id={props.item.id ?? ""}>
      extra
      {props.item.kind !== "user" ? <HooksProbe /> : null}
    </div>
  );
}

/** The `tool.result` cell for this plugin's own tool. */
export function WindowResult({ props }: { props: { tool: string; item: Item } }) {
  return (
    <div data-acceptance-window="tool-result" data-tool={props.tool} data-result={JSON.stringify(props.item.result ?? props.item).slice(0, 400)}>
      window result
    </div>
  );
}

function KeptChild() {
  const [n, setN] = useKept<number>("count", 0);
  return <button type="button" data-acceptance-window="kept" data-count={n} onClick={() => setN((v) => v + 1)}>kept {n}</button>;
}

/** The probe under the user's message (the hooks run in the plugin's own frame in Alpha's tab): each hook tried once, its result in an attribute. */
function HooksProbe() {
  const [out, setOut] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setOut((o) => ({ ...o, [k]: v }));
  const menu = useMenu();
  const open = useOpen();
  const drag = useDrag();
  const approvals = useApprovals();
  const questions = useQuestions();
  const userSend = useUserSend();
  const composerHost = useComposerHost();
  const surface = useSurface();
  const viewFrame = useViewFrame("acceptance-window");
  const [remount, setRemount] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    set("approvals", String(Array.isArray(approvals.cards) ? approvals.cards.length : "no list"));
    set("questions", String(Array.isArray(questions.questions) ? questions.questions.length : "no list"));
    set("usersend", userSend === undefined ? "undefined" : "function");
    set("composerhost", composerHost === undefined ? "undefined" : "defined");
    set("surface", typeof surface);
    viewFrame(box.current);
    set("viewframe", "called");
    return () => viewFrame(null);
  }, []);
  const press = (k: string, run: () => Promise<string>) => () => { run().then((v) => set(k, v), (e: unknown) => set(k, `refused: ${String(e).slice(0, 160)}`)); };
  return (
    <div data-acceptance-window="page" {...Object.fromEntries(Object.entries(out).map(([k, v]) => [`data-${k}`, v]))}>
      <p>Acceptance window</p>
      <div ref={box} />
      <button type="button" data-acceptance-window="menu" onClick={press("menu", async () => String(await menu([{ id: "one", label: "One" }, { id: "two", label: "Two" }], { x: 20, y: 20 })))}>menu</button>
      <button type="button" data-acceptance-window="open" onClick={press("open", async () => { await open({ kind: "settings" }); return "opened"; })}>open</button>
      <button type="button" data-acceptance-window="drag" onClick={press("drag", async () => {
        const offered = await drag.offer({ type: "text/plain", data: "acceptance-drag-text" });
        if (offered === undefined) return "no token";
        const claimed = await drag.claim(offered);
        return `claimed:${String((claimed as { data?: unknown } | undefined)?.data)}`;
      })}>drag</button>
      <button type="button" data-acceptance-window="remount" onClick={() => setRemount((n) => n + 1)}>remount</button>
      <KeptChild key={remount} />
    </div>
  );
}
