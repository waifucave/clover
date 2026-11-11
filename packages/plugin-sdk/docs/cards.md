# Cards: styling and placing approval cards

An approval card asks the user to say yes or no to something an agent wants to do. The core hands a card to the app as **sealed** fields (the words) and
**sealed** Approve and Deny buttons. A plugin can style a card and place it, and it never sees a word of it. That is the whole security boundary: the
user decides by what the sealed frames say, and only a press the app saw itself, on a button that is visible and uncovered, is an answer.

## What a plugin can do

| You want | You do | You need |
|---|---|---|
| Make the card look like your bot | put `card.*` tokens in your bot's tab theme | nothing: a theme is data |
| Put your bot's card where your page wants it | place it with `<Card>` from `@waifucave/clover-plugin-sdk/ui` | `approvals` in the manifest's `capabilities` |
| Know which cards wait (ids, places, options, never text) | `useApprovals()`, or `api.approvals.pending()` / `api.approvals.watch(fn)` in a component | `approvals` |

### 1. Styling: the `card.*` tokens

While your bot's tab shows, a card of that bot's conversation wears your tab's `card.*` tokens. The names are these (all in the theme schema, with defaults
for both appearances):

`card.background`, `card.text`, `card.muted`, `card.rim`, `card.radius`, `card.padding`, `card.approve.background`, `card.approve.text`,
`card.deny.background`, `card.deny.text`, `card.button.radius`, `card.font.family`, `card.font.size`.

Alpha's `plugins/alpha/tab/theme.json` is a worked set (ink on cream by day, gold on navy by night). Sealed frames take only these names: any other token
is ignored, so a theme cannot restyle the words into something unreadable by another route.

The island and the pill (the app's own surfaces) wear the app's `island.*` and `pill.*` tokens, not a bot's. A card shown there looks like the app's.

### 2. Placing: the card kit

```tsx
import { Card, useApprovals } from "@waifucave/clover-plugin-sdk/ui";

export function SideCard() {
  const { cards } = useApprovals();            // this plugin's own bot's pending cards, as ids and places
  const mine = cards.find((c) => c.kind === "tool");
  if (mine === undefined) return null;
  return (
    <Card id={mine.id}>
      <Card.Field name="summary" />            {/* the one sealed line: what is being asked */}
      <Card.Approve />                         {/* the first approve option, its own sealed label */}
      <Card.Deny />
    </Card>
  );
}
```

Declare it in a spot your plugin fills (a page, a side area), and give the plugin `"capabilities": ["approvals"]`. The elements:

- `<Card id>` holds the frames and takes `tokens` (`card.*` only) and a `className` for the layout of the holder.
- `<Card.Field name>` is one sealed field. A field the card does not have draws nothing and takes no room.
- `<Card.Approve>` and `<Card.Deny>` are sealed buttons: `option` picks one by id (an "always" option, say), and `look` may be `label`, or a glyph
  (`check` on an approve, `cross` on a deny).

You place frames and size the boxes around them; you cannot read, change, screenshot or script what is inside.

### Whose cards you hear and place

A plugin hears and places only the cards **of its own bots** (a bot's id is `<plugin>` or `<plugin>/<name>`; the top-level id decides). The core sends
`card_pending` to your plugin only for those, `card.pending` lists only those, and the app refuses to place a frame of any other card, including the
user's own sessions' and a plugin's OK card. The bundled `clover` tree (the shell, the island, the pill) hears all of them.

## When an answer counts

A press is taken only if the app saw it: a real pointer or key press, while the whole button is on screen, at 24 by 24 CSS pixels or more, and
nothing covers it. So:

- No `filter`, no `opacity` below 1, and no `transform` other than a move or an enlargement on a frame or anything around it. A frame so styled counts as
  hidden, and a press on it is not an answer.
- No rotation, and nothing placed over the button.
- A page that is not showing (another tab, a collapsed column) reports its frames hidden. Put the card where the user sees it.
- A press while the app is acting for the user (Computer Use) does not count, and nor does a second press.

## The 2-second fallback

If, within 2 seconds of a card's being raised, no plugin shows both an Approve and a Deny button visibly, the app draws its own small card window with
the same sealed words, so a plugin that hides, covers or forgets a card cannot leave the user unable to answer, or an agent stuck. The fallback is
per card. It is the app's, and a plugin cannot style or suppress it.

## Which cards you can place

| Card | Carries a session | Where it can be placed |
|---|---|---|
| A session's card: a tool call (including RequestAccess), an agent's permission or unsandboxed start | yes | the conversation, a part of the bot's own tab (your page, a side area), the island, the pill, the fallback |
| A plugin's OK, a bot's provider consent, a change from Settings, a confirm | no | the island, the pill, the fallback (and the bundled tree's parts) |

A card with no session or no bot reaches the bundled `clover` tree alone: a third-party plugin is never offered it.

## Questions are not cards

A question an agent asks (`AskUserQuestion`) is an ordinary cell in the conversation, with its own words, readable like any message by a plugin that can
read the conversation. Only approvals, the things the user must decide with a sealed answer, are cards. Style a question the way you style a message.
