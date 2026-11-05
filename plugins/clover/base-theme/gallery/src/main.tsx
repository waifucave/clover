// The lane's gallery page. `?story=<id>` draws one story alone at its frame's size (what CI screenshots,
// one page load per story, so each WebGL avatar gets a context of its own); no query lists them all.

import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ISLAND_STORIES } from "../../../island/src/gallery";
import { PILL_STORIES } from "../../../pill/src/gallery";
import { Specimen } from "./specimen";
import { BASE_LAYER, scopedCss, themeStyle, type ThemeLayer } from "./themes";
import type { Appearance } from "../../src/theme";

export interface GalleryStory {
  id: string;
  title: string;
  width: number;
  height: number;
  render: () => ReactNode;
  /** A theme stack drawn on the frame's root. */
  theme?: string;
  /** Resolves once the frame may be captured (a model loaded, a frame drawn). */
  ready?: () => Promise<void>;
}

const STACKS: Record<string, { layers: readonly ThemeLayer[]; appearance: Appearance }> = {
  "base-light": { layers: [BASE_LAYER], appearance: "light" },
  "base-dark": { layers: [BASE_LAYER], appearance: "dark" },
};

const THEME_STORIES: GalleryStory[] = [
  { id: "theme/base-light", title: "Base theme, light", width: 1000, height: 470, theme: "base-light", render: () => <Specimen title="Clover, light" /> },
  { id: "theme/base-dark", title: "Base theme, dark", width: 1000, height: 470, theme: "base-dark", render: () => <Specimen title="Clover, dark" /> },
];

export const STORIES: GalleryStory[] = [...THEME_STORIES, ...ISLAND_STORIES, ...PILL_STORIES];

declare global {
  interface Window {
    __galleryReady?: boolean;
    __galleryError?: string;
    __galleryStories?: { id: string; title: string; width: number; height: number }[];
  }
}

function Frame({ story, bare }: { story: GalleryStory; bare: boolean }): ReactElement {
  const stack = story.theme ? STACKS[story.theme] : undefined;
  const style: CSSProperties = { width: story.width, height: story.height, ...(stack ? themeStyle(stack.layers, stack.appearance) : {}) };
  const frame = (
    <div className="g-frame" data-frame="" data-theme-root={story.theme} style={style}>
      {story.render()}
    </div>
  );
  if (bare) return frame;
  return (
    <section className="g-story" data-story={story.id}>
      <h2 className="g-title">
        {story.title} <span className="g-id">{story.id}</span>
      </h2>
      {frame}
    </section>
  );
}

function Ready({ story, children }: { story?: GalleryStory; children: ReactNode }): ReactElement {
  useEffect(() => {
    let cancelled = false;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    (async () => {
      try {
        await settle();
        if (story?.ready) await story.ready();
        await settle();
        if (!cancelled) window.__galleryReady = true;
      } catch (error) {
        window.__galleryError = String(error instanceof Error ? error.stack ?? error.message : error);
        window.__galleryReady = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [story]);
  return <>{children}</>;
}

const params = new URLSearchParams(location.search);
const only = params.get("story");
window.__galleryStories = STORIES.map(({ id, title, width, height }) => ({ id, title, width, height }));

const style = document.createElement("style");
style.textContent = scopedCss(
  "data-theme-root",
  Object.fromEntries(Object.entries(STACKS).map(([name, stack]) => [name, stack.layers])),
);
document.head.appendChild(style);

const root = createRoot(document.getElementById("root")!);
if (only) {
  const story = STORIES.find((s) => s.id === only);
  document.body.dataset.bare = "true";
  root.render(story ? <Ready story={story}><Frame story={story} bare /></Ready> : <p>No story {only}</p>);
  if (!story) window.__galleryError = `no story ${only}`;
} else {
  root.render(
    <Ready>
      <h1 className="g-h1">Clover lane G gallery</h1>
      {STORIES.map((story) => (
        <Frame key={story.id} story={story} bare={false} />
      ))}
    </Ready>,
  );
}
