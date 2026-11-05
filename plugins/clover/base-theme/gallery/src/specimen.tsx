// A theme's specimen: every plane, the text ladder, the accent and its meanings, a message pair, the
// composer and an approval card's tokens, drawn from tokens only. It shows what a theme does to the
// parts that read it; the parts themselves (sidebar, conversation, composer) are lane F's.

import type { CSSProperties, ReactElement } from "react";

const v = (name: string) => `var(--${name.replaceAll(".", "-")})`;

const label: CSSProperties = { fontSize: v("font.size.caption"), color: v("color.text.muted") };

function Swatch({ token, name }: { token: string; name: string }): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ height: 34, borderRadius: v("radius.medium"), background: v(token), boxShadow: `inset 0 0 0 1px ${v("color.hairline.raised")}` }} />
      <span style={label}>{name}</span>
    </div>
  );
}

export function Specimen({ title }: { title: string }): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        width: "100%",
        height: "100%",
        background: v("color.canvas"),
        color: v("color.text"),
        fontFamily: v("font.sans"),
        fontSize: v("font.size.body"),
      }}
    >
      <aside style={{ padding: "20px 12px", display: "flex", flexDirection: "column", gap: 4, borderRight: `1px solid ${v("color.hairline")}` }}>
        <div style={{ fontFamily: v("font.display"), fontSize: v("font.size.title"), fontWeight: 600, padding: "0 8px 14px" }}>Clover</div>
        {["Alpha", "Luna", "Settings"].map((name, i) => (
          <div
            key={name}
            style={{
              padding: "6px 8px",
              borderRadius: v("radius.small"),
              fontSize: v("font.size.control"),
              color: v("color.text.secondary"),
              background: i === 0 ? v("color.selected") : i === 1 ? v("color.hover") : "transparent",
            }}
          >
            {name}
          </div>
        ))}
        <div style={{ ...label, padding: "18px 8px 0" }}>Selection stays neutral; Luna is under the pointer.</div>
      </aside>
      <main style={{ background: v("color.surface"), padding: 24, display: "flex", flexDirection: "column", gap: 18, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ fontFamily: v("font.display"), fontSize: v("font.size.display"), lineHeight: v("font.line.tight") }}>{title}</span>
          <span style={label}>Drawn from tokens; the real parts are lane F's</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
          <Swatch token="color.canvas" name="canvas" />
          <Swatch token="color.surface" name="surface" />
          <Swatch token="color.raised" name="raised" />
          <Swatch token="color.control" name="control" />
          <Swatch token="color.float" name="float" />
          <Swatch token="color.accent" name="accent" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ alignSelf: "flex-end", maxWidth: "80%", padding: "9px 14px", borderRadius: v("bubble.radius"), background: v("bubble.user.background"), color: v("bubble.user.text") }}>
              Can you tidy the release notes before I post them?
            </div>
            <div style={{ maxWidth: "92%", padding: "9px 14px", borderRadius: v("bubble.radius"), background: v("bubble.bot.background"), color: v("bubble.bot.text"), boxShadow: `inset 0 0 0 1px ${v("bubble.bot.rim")}`, lineHeight: v("font.line.body") }}>
              Done. I merged the two bug-fix sections and moved the Windows note to the top. <a href="#notes">See the diff</a>.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 16px", borderRadius: v("composer.radius"), background: v("composer.background"), boxShadow: `inset 0 0 0 1px ${v("composer.rim")}, ${v("shadow.raised")}` }}>
              <span style={{ flex: 1, color: v("composer.placeholder") }}>Message Alpha</span>
              <span style={{ width: 32, height: 32, borderRadius: v("radius.round"), background: v("color.accent"), color: v("color.accent.contrast"), display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>↑</span>
            </div>
          </div>
          <div
            style={{
              padding: v("card.padding"),
              borderRadius: v("card.radius"),
              background: v("card.background"),
              color: v("card.text"),
              boxShadow: `inset 0 0 0 1px ${v("card.rim")}`,
              fontFamily: v("card.font.family"),
              fontSize: v("card.font.size"),
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <span style={{ fontSize: v("font.size.caption"), color: v("card.muted") }}>Alpha · Bash · on Studio</span>
            <span>Run a command that deletes the build folder and rebuilds the site</span>
            <code style={{ fontSize: v("font.size.label"), background: v("color.control"), borderRadius: v("radius.small"), padding: "6px 8px" }}>rm -rf dist && bun run build</code>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <span style={{ padding: "6px 14px", borderRadius: v("card.button.radius"), background: v("card.deny.background"), color: v("card.deny.text"), fontWeight: 500 }}>Deny</span>
              <span style={{ padding: "6px 14px", borderRadius: v("card.button.radius"), background: v("card.approve.background"), color: v("card.approve.text"), fontWeight: 600 }}>Allow once</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 22, alignItems: "center", fontSize: v("font.size.label") }}>
          <span style={{ color: v("color.text") }}>Text</span>
          <span style={{ color: v("color.text.secondary") }}>Secondary</span>
          <span style={{ color: v("color.text.muted") }}>Muted</span>
          <span style={{ color: v("color.text.placeholder") }}>Placeholder</span>
          <span style={{ color: v("color.accent.text") }}>Link</span>
          <span style={{ color: v("color.attention.text") }}>● Needs you</span>
          <span style={{ color: v("color.success") }}>● Running</span>
          <span style={{ color: v("color.danger") }}>● Failed</span>
          <span style={{ padding: "3px 10px", borderRadius: v("radius.round"), background: v("color.accent.soft"), color: v("color.accent.text") }}>Chosen</span>
          <span style={{ padding: "3px 10px", borderRadius: v("radius.small"), outline: `2px solid ${v("color.focus")}`, outlineOffset: 2 }}>Focused</span>
        </div>
      </main>
    </div>
  );
}
