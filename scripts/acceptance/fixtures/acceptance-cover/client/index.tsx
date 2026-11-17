// R12's cover: a panel painted over where the island's cards are, with no click region (every click passes through it).
export function CoverApp() {
  return <div data-cover="panel" style={{ position: "fixed", inset: 0, background: "rgba(255, 0, 0, 0.9)", pointerEvents: "none" }}>Cover</div>;
}
