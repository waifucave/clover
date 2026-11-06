// What the pill's `app.surface` entry reads from the app until lane E's runtime gives it `usePluginApi()` (`bots`),
// `useApprovals()` and the `pill.target` entries: one context, so the gallery and the tests hand a stand-in and E-M1
// hands the real thing. `PillApp` is the component the manifest names; it takes only its `EntryProps`.

import { createContext, useContext, useMemo, useState, type ReactElement } from "react";
import { chooseTarget, pillTargets, storageMemory, userSendTarget, type PillBot, type PillTargetEntry, type ResolvedTarget, type TargetMemory, type TargetRef, type UserSendTarget } from "../model/targets";
import { DispatchPill, type DispatchPillProps } from "./DispatchPill";
import { setTranslator, type Translator } from "../strings";

/** What the pill shows about one target's turn: the running state, its cards, its agents (lane D's sessions). */
export type TargetTurn = Omit<DispatchPillProps, "target" | "targets" | "onTarget" | "onSend">;

export interface PillHost {
  /** `bots.read`: every bot, in the order the user keeps them. */
  bots: readonly PillBot[];
  /** The `pill.target` entries the spot shows (a question for lane B: how a declaring component lists them). */
  targets?: readonly PillTargetEntry[];
  /** The last target picked on this device; the layer's storage when absent. */
  memory?: TargetMemory;
  /**
   * `useUserSend()` (lane B's `UiApi`): the runtime's user-send, which only the bundled `clover` tree's surfaces get. The
   * pill calls it synchronously, inside the key press or click that sent, and the runtime counts it only within that
   * frame's transient user activation, refusing any other (§5.5). The runtime carries the words to the daemon through
   * an `app`-role method (`pill.send`, B's to pin), never a layer method, and the daemon hands them to a bot's main
   * conversation as the user's message, or to a `pill.target` entry's handler. The pill has no `conversation.post`,
   * whose turns are the plugin's, never the user's. A refusal puts the words back in the field.
   */
  send(to: UserSendTarget, message: string): Promise<void>;
  /** The turn the pill shows for a target. */
  turn?(target: TargetRef): TargetTurn;
  /** The app's translator for this plugin's keys (lane E's `useT()`): the words in the user's language, English for a
   *  key it lacks. Absent, English. */
  t?: Translator;
}

export const PillHostContext = createContext<PillHost | null>(null);

/** What lane B's `EntryProps` hands every entry. */
export interface PillEntryProps<P> {
  props: P;
  tokens?: Readonly<Record<string, unknown>>;
  entry?: { pluginId: string; id: string; spot: string; key?: string };
}

/** The `app.surface` entry: the Dispatch pill, messaging the target picked last. */
export function PillApp(_: PillEntryProps<{ surface: string }>): ReactElement | null {
  const host = useContext(PillHostContext);
  setTranslator(host?.t ?? null);
  const memory = useMemo(() => host?.memory ?? storageMemory(), [host?.memory]);
  const targets = useMemo(() => pillTargets(host?.bots ?? [], host?.targets ?? []), [host?.bots, host?.targets]);
  const [picked, setPicked] = useState<string | null>(() => memory.get());
  if (!host) return null;
  const target: ResolvedTarget | null = chooseTarget(targets, picked);
  if (!target) return null;
  return (
    <DispatchPill
      {...host.turn?.(target.ref)}
      target={target}
      targets={targets}
      onTarget={(id) => {
        memory.set(id);
        setPicked(id);
      }}
      onSend={(text) => host.send(userSendTarget(target.ref), text)}
    />
  );
}
