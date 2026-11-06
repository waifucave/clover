// A mocked bot and the avatars two packs offer, for the gallery and the tests.
import type { AvatarChoice, BotEditorModel } from "../client/types";

function face(letter: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><circle cx="28" cy="28" r="28" fill="url(#g)"/><text x="28" y="36" font-family="system-ui, sans-serif" font-size="24" font-weight="600" text-anchor="middle" fill="#ffffff">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const ALPHA = { id: "alpha", name: "Alpha", portraitUrl: face("A", "#8ccbf0", "#3d7fb0") };

export const MODELS: BotEditorModel[] = [
  { id: "openai/gpt-6", label: "GPT-6", detail: "OpenAI", efforts: ["low", "medium", "high", "max"] },
  { id: "xai/grok-5", label: "Grok 5", detail: "xAI" },
  { id: "moonshot/kimi-k3", label: "Kimi K3", detail: "Moonshot", efforts: ["low", "high"] },
];

export const AVATARS: AvatarChoice[] = [
  { id: "alpha#alpha", name: "Alpha", pack: "Alpha", file: "avatars/alpha.vrm", format: "vrm", portraitUrl: face("A", "#8ccbf0", "#3d7fb0") },
  { id: "chibi-pack#mint", name: "Mint", pack: "Chibi pack", file: "avatars/mint.vrm", format: "vrm", portraitUrl: face("M", "#a7f2c9", "#3db07a") },
  { id: "chibi-pack#rose", name: "Rose", pack: "Chibi pack", file: "avatars/rose.vrm", format: "vrm", portraitUrl: face("R", "#f2a7c3", "#b03d6a") },
  { id: "paper-dolls#ink", name: "Ink", pack: "Paper dolls", file: "models/ink.model3.json", format: "live2d" },
];

export const THEMES = [
  { id: "clover/base-theme#base", name: "Plain" },
  { id: "alpha#alpha-tab", name: "Alpha's tab" },
  { id: "midnight#midnight", name: "Midnight" },
];
