// A bot's living face (spec §6.9): the living-bots kit's bot for its name, or for the traits the person pinned in its
// record, in the mood the activity feed says. The kit runs every face on the page from one loop, rests a face while it is
// off screen, and leaves out jumps and turns for people who ask their system for less motion. A mood is shown by motion
// alone, so every place that shows a face also says the mood in words (MoodWords).
import { useEffect, useRef } from "react";
import { COLORS, mount, type Handle, type Mood } from "./living-bots";
import { MOOD_WORDS } from "../../shared/view";
import type { BotFace } from "@waifucave/moss-protocol";

/** Whether faces hold still (the renders; the system's reduced-motion setting is the kit's own default otherwise). */
export const faceMotion = { calm: undefined as boolean | undefined };

function dark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function Face(props: { name: string; face?: BotFace; mood: Mood; size: number; surface?: "list" | "page" | "header" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<Handle | null>(null);
  const traits = { ...(props.face?.shape !== undefined ? { shape: props.face.shape as never } : {}), ...(props.face?.color !== undefined ? { color: props.face.color } : {}) };
  const key = `${props.name}|${traits.shape ?? ""}|${traits.color ?? ""}`;
  useEffect(() => {
    const c = canvas.current;
    if (c === null) return;
    const d = dark();
    // The surface behind the face, so a sleeping bot fades toward it.
    const surface = d ? COLORS.night : "#FFFFFF";
    const h = mount(c, props.name, { ...traits, mood: props.mood, scale: 1.2, dark: d, surface, ...(faceMotion.calm !== undefined ? { calm: faceMotion.calm } : {}) });
    handle.current = h;
    const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    const onScheme = () => h.set({ dark: dark(), surface: dark() ? COLORS.night : "#FFFFFF" });
    scheme?.addEventListener("change", onScheme);
    return () => {
      scheme?.removeEventListener("change", onScheme);
      h.destroy();
      handle.current = null;
    };
    // The kit's bot is made once per name and pinned traits; the mood changes below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    handle.current?.setMood(props.mood);
  }, [props.mood]);
  useEffect(() => {
    if (faceMotion.calm !== undefined) handle.current?.set({ calm: faceMotion.calm });
  });
  // The name is said beside the face, so the canvas is decoration for a screen reader.
  return <canvas ref={canvas} data-face={props.name} aria-hidden="true" className={`face face--${props.surface ?? "list"}`} style={{ width: props.size, height: props.size }} />;
}

/** The mood in words, beside every face (`working` names its tool's short name when the feed gives one). */
export function MoodWords(props: { mood: Mood; tool?: string }) {
  const tool = props.mood === "working" && props.tool !== undefined ? toolName(props.tool) : undefined;
  return <span className={`mood mood--${props.mood}`} data-mood-words={props.mood}>{MOOD_WORDS[props.mood]}{tool !== undefined ? ` · ${tool}` : ""}</span>;
}

/** A tool's wire name (`mcp__moss__Browser`) as a person reads it (`Browser`). */
export function toolName(wire: string): string {
  const parts = wire.split("__");
  return (parts[parts.length - 1] ?? wire).slice(0, 40);
}
