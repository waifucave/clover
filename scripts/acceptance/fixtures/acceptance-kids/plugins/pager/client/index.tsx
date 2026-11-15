// The child's page (the `main` spot, opened from its sidebar app button): its own words, drawn in its own layer.
export function PagerMain() {
  return <p data-acceptance-kids="main">Kids pager page</p>;
}

/** The sidebar app entry's component (the sidebar draws its button from the entry's title and icon). */
export function PagerBadge() {
  return <span data-acceptance-kids="badge">•</span>;
}
