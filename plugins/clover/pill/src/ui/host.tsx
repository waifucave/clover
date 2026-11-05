// What the pill's `app.surface` entry reads from the app until lane E's runtime gives it `usePluginApi()` (`bots`),
// `useApprovals()` and the `pill.target` entries: one context, so the gallery and the tests hand a stand-in and E-M1
// hands the real thing. `PillApp` is the component the manifest names; it takes only its `EntryProps`.

import { createContext, useContext, useMemo, useState, type ReactElement } from "react";
import { chooseTarget, pillTargets, storageMemory, type PillBot, type PillTargetEntry, type ResolvedTarget, type TargetMemory, type TargetRef } from "../model/targets";
import { DispatchPill, type DispatchPillProps } from "./DispatchPill";

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
   * The host's user-send callback (§5.5's rule for a send that counts as the user's): the pill calls it synchronously,
   * inside the key press or click that sent, and the host counts it only while that frame's transient user activation
   * from the hardware is there, refusing any other. The pill has no `conversation.post`, whose turns are the plugin's,
   * never the user's. To a bot, the user's message; to a plugin's target, its handler (B's shape, asked).
   */
  send(target: TargetRef, text: string): void | Promise<void>;
  /** The turn the pill shows for a target. */
  turn?(target: TargetRef): TargetTurn;
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
      onSend={(text) => void host.send(target.ref, text)}
    />
  );
}
