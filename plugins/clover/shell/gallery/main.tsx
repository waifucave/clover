// The lane F gallery: every part in every state, in one page. `?story=<id>` shows one story;
// `?theme=dark` starts dark. CI renders each story's frame to PNG in both themes (shoot.mjs).
import "../../conversation/client/styles.css";
import "../../conversation/gallery/mock-runtime.css";
import "../../conversation/gallery/stories.css";
import "../../composer/client/styles.css";
import "../../composer/gallery/stories.css";
import "../client/styles.css";
import "./stories.css";
import "./theme.css";
import "./page.css";
import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { stories as composerStories } from "../../composer/gallery/stories";
import { stories as conversationStories } from "../../conversation/gallery/stories";
import { composedStories } from "./composed";
import type { Story } from "./story";
import { stories as sidebarStories } from "./stories";

export const GROUPS: { title: string; stories: Story[] }[] = [
  { title: "Conversation", stories: conversationStories },
  { title: "Composer", stories: composerStories },
  { title: "Sidebar", stories: sidebarStories },
  { title: "Together", stories: composedStories },
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
      <div className="g-frame" style={{ width: story.width ?? 880, height: story.height }}>
        <Boundary id={story.id}>{story.render()}</Boundary>
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
  useEffect(() => setReady(true), []);
  const groups = GROUPS.map((g) => ({ ...g, stories: g.stories.filter((s) => !only || s.id === only) })).filter((g) => g.stories.length > 0);
  return (
    <main className="g-page" data-gallery-ready={ready ? "" : undefined}>
      <header className="g-header">
        <h1>Clover: the conversation parts</h1>
        <p>Lane F, M1. Plain React against mocked props, on a stand-in theme.</p>
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
