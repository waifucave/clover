// The card fixture's page: places the first pending tool card of its own bot with the SDK's card kit, in a box of its
// own, and says on data attributes which cards it was told of. The badge (always mounted in the sidebar) says the same, so
// the run can tell "told of no card" from "not mounted".
import { Card, useApprovals } from "@waifucave/clover-plugin-sdk/ui";

export function CardsMain() {
  const { cards } = useApprovals();
  const mine = cards.find((c) => c.kind === "tool");
  return (
    <div data-cards-a="main" data-ids={cards.map((c) => c.id).join(",")} data-placed={mine?.id ?? ""} style={{ padding: 24 }}>
      <p>Acceptance cards A</p>
      {mine !== undefined && (
        <Card id={mine.id}>
          <div data-cards-a="field" style={{ width: 420, minHeight: 40 }}><Card.Field name="summary" /></div>
          <div data-cards-a="approve" style={{ width: 200, height: 48, marginTop: 12 }}><Card.Approve /></div>
          <div data-cards-a="deny" style={{ width: 200, height: 48, marginTop: 12 }}><Card.Deny /></div>
        </Card>
      )}
    </div>
  );
}

export function CardsBadge() {
  const { cards } = useApprovals();
  return <span data-cards-a="badge" data-ids={cards.map((c) => c.id).join(",")}>•</span>;
}
