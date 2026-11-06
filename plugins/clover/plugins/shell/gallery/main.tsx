// The lane F gallery: every part in every state, in one page. `?story=<id>` shows one story;
// `?theme=dark` starts dark. CI renders each story's frame to PNG in both themes (shoot.mjs).
//
// The whole-window screens run the default shell on the stand-in runtime over a pretend world (world.tsx), whose
// fixtures sit on November 5, 2026: the page pins the clock there, so every render reads the same, and it says it
// is ready only once the worlds' calls have all come back.
import "../../conversation/client/styles.css";
import "../../conversation/gallery/mock-runtime.css";
import "../../conversation/gallery/stories.css";
import "../../composer/client/styles.css";
import "../../composer/gallery/stories.css";
import "../../panel/client/styles.css";
import "../../panel/gallery/stories.css";
import "../../panel-terminal/client/styles.css";
import "../../panel-terminal/gallery/stories.css";
import "../../panel-diff/client/styles.css";
import "../../panel-diff/gallery/stories.css";
import "../../panel-files/client/styles.css";
import "../../settings/client/styles.css";
import "../../bot-editor/client/styles.css";
import "../../plugin-index/client/styles.css";
import "../../archive/client/styles.css";
import "../../archive/gallery/stories.css";
import "../../sidebar/client/styles.css";
import "../../sidebar/gallery/stories.css";
import "../client/styles.css";
import "./stories.css";
import "./theme.css";
import "./page.css";
import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { stories as composerStories } from "../../composer/gallery/stories";
import { stories as conversationStories } from "../../conversation/gallery/stories";
import { diffStories } from "../../panel-diff/gallery/stories";
import { filesStories } from "../../panel-files/gallery/stories";
import { terminalStories } from "../../panel-terminal/gallery/stories";
import { panelStories } from "../../panel/gallery/stories";
import { settingsStories } from "../../settings/gallery/stories";
import { botEditorStories } from "../../bot-editor/gallery/stories";
import { pluginIndexStories } from "../../plugin-index/gallery/stories";
import { archiveStories } from "../../archive/gallery/stories";
import { stories as sidebarStories } from "../../sidebar/gallery/stories";
import { screenStories } from "./screens";
import { shellStories } from "./stories";
import type { Story } from "./story";
import { NOW, whenIdle } from "./world";

// The fixtures' clock (see above).
Date.now = () => NOW;

export const GROUPS: { title: string; stories: Story[] }[] = [
  { title: "Whole window", stories: screenStories },
  { title: "Conversation", stories: conversationStories },
  { title: "Composer", stories: composerStories },
  { title: "Sidebar", stories: sidebarStories },
  { title: "Panel", stories: panelStories },
  { title: "Terminal", stories: terminalStories },
  { title: "Changes", stories: diffStories },
  { title: "Files", stories: filesStories },
  { title: "Settings", stories: settingsStories },
  { title: "Bot editor", stories: botEditorStories },
  { title: "Plugin index", stories: pluginIndexStories },
  { title: "Archive", stories: archiveStories },
  { title: "The shell's own parts", stories: shellStories },
];

/** Keeps one broken story from taking the page down, and marks it for the screenshot run. */
class Boundary extends Component<{ id: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="g-error" data-story-error={this.props.id}>
        {String(error.stack ?? error)}
      </div>
    );
  }
}

function StoryView({ story }: { story: Story }) {
  return (
    <section className="g-story" id={story.id} data-story={story.id}>
      <h3 className="g-story__title">
        {story.title}
        <span className="g-story__id">{story.id}</span>
      </h3>
      {story.notes && <p className="g-story__notes">{story.notes}</p>}
      <div className="g-frame" data-desktop={story.desktop || undefined} style={{ width: story.width ?? 880, height: story.height }}>
        <Boundary id={story.id}>{story.render()}</Boundary>
        {story.desktop && (
          <span className="g-frame__controls" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
    </section>
  );
}

function Gallery() {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const only = params.get("story");
  const [theme, setTheme] = useState(params.get("theme") === "dark" ? "dark" : "light");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    let live = true;
    void whenIdle().then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  const groups = GROUPS.map((g) => ({ ...g, stories: g.stories.filter((s) => !only || s.id === only) })).filter((g) => g.stories.length > 0);
  return (
    <main className="g-page" data-gallery-ready={ready ? "" : undefined}>
      <header className="g-header">
        <h1>Clover: the window and its parts</h1>
        <p>Lane F, M2. The default shell on the runtime, every spot filled by the parts' own entries over a pretend core; each part alone against mocked props. Lane G's base theme, lane B's token names.</p>
        <span className="g-theme" role="group" aria-label="Theme">
          {(["light", "dark"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
              {t}
            </button>
          ))}
        </span>
      </header>
      {!only && (
        <ul className="g-toc">
          {GROUPS.flatMap((g) => g.stories).map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.id}</a>
            </li>
          ))}
        </ul>
      )}
      {groups.map((group) => (
        <div key={group.title}>
          <h2 className="g-group">{group.title}</h2>
          {group.stories.map((story) => (
            <StoryView key={story.id} story={story} />
          ))}
        </div>
      ))}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Gallery />);
