// Cards with no session (spec §5.5): what Settings or the plugins page raised (a level change, removing a device, a
// plugin's OK) belongs to no conversation, so the shell places it, in a strip at the top of the main column under the
// title bar, in the flow: nothing lies over it, and it neither fades nor moves (the core counts a click on a sealed
// button only then). Each card's words are the core's sealed frames; the shell only lays them out, one sealed button
// per option (the deny options first, then an "always" approve, then the plain approve, where the eye ends).
import type { CardMeta } from "../runtime/types";
import type { SealedField } from "../runtime/ui";
import { Card } from "./sdk";
import { S } from "./strings";

const FIELDS: readonly SealedField[] = ["source", "what", "host", "command", "paths", "computer", "risk", "reason", "detail", "expires"];

function Buttons({ options }: { options: CardMeta["options"] }) {
  const ordered = options.length
    ? [...options.filter((o) => o.kind === "deny"), ...options.filter((o) => o.kind === "approve" && o.remember === "always"), ...options.filter((o) => o.kind === "approve" && o.remember !== "always")]
    : undefined;
  return (
    <div className="cl-cards__buttons">
      {ordered ? (
        ordered.map((o) => (
          <span key={o.id} className="cl-cards__button" data-kind={o.kind}>
            {o.kind === "approve" ? <Card.Approve option={o.id} /> : <Card.Deny option={o.id} />}
          </span>
        ))
      ) : (
        <>
          <span className="cl-cards__button">
            <Card.Deny />
          </span>
          <span className="cl-cards__button">
            <Card.Approve />
          </span>
        </>
      )}
    </div>
  );
}

/** The cards waiting with no session, oldest first. */
export function WaitingCards({ cards }: { cards: readonly CardMeta[] }) {
  if (cards.length === 0) return null;
  const sorted = [...cards].sort((a, b) => a.issuedAt - b.issuedAt);
  return (
    <div className="cl-cards" role="region" aria-label={S.cardsWaiting}>
      {sorted.map((c) => (
        <section key={c.id} className="cl-cards__card" data-card={c.kind} aria-label={S.cardWaiting}>
          <Card id={c.id}>
            <div className="cl-cards__title">
              <Card.Field name="title" />
            </div>
            {FIELDS.map((f) => (
              <div key={f} className="cl-cards__field" data-slot={f}>
                <Card.Field name={f} />
              </div>
            ))}
            <Buttons options={c.options} />
          </Card>
        </section>
      ))}
    </div>
  );
}
