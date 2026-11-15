// A streamed reply's cost per word at a long transcript (45 turns, 135 rows): the projection, the timeline and the
// draw of the view for one more word, in the test DOM. Was 33 ms a word (every row drawn again, every message's day read
// with a new formatter); the bound leaves several times the room it needs now, and catches a return to drawing every row.
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ConversationView } from "../client/ConversationView";
import type { ConversationItem } from "../client/types";
import { UiRuntimeProvider } from "../client/sdk";
import { at, bot, BOT, DEVICE, FORMAT, NOW, user, SEALED_CARDS, tool } from "../gallery/fixtures";
import { mockRuntime } from "../gallery/mock-runtime";
afterEach(cleanup);
test("one more streamed word costs a few milliseconds at 135 rows, not every row's draw", () => {
  const history: ConversationItem[] = [];
  for (let i = 0; i < 45; i++) {
    history.push(user(at(0, 1, i * 3), `question ${i} `.repeat(5)));
    history.push(tool(at(0, 1, i * 3 + 1), { name: "Read", argsJson: JSON.stringify({ file_path: "/x/y.txt" }), status: "ok", output: "x".repeat(500) } as never) as ConversationItem);
    history.push(bot(at(0, 1, i * 3 + 2), `answer ${i} with **bold** and a list:\n\n- one\n- two\n\nMore text here. `.repeat(3)));
  }
  const runtime = mockRuntime({ cards: SEALED_CARDS });
  const view = (items: ConversationItem[]) => (<UiRuntimeProvider runtime={runtime}><ConversationView bot={BOT} now={NOW} device={DEVICE} format={FORMAT} items={items} onCopy={() => undefined} /></UiRuntimeProvider>);
  let text = "";
  const r = render(view([...history]));
  const N = 60;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    text += `word${i} `;
    if (i % 20 === 19) text += "\n\n";
    const items = [...history.map((h) => structuredClone(h)), { ...bot(at(0, 2, 0), text), id: "streaming", streaming: true } as ConversationItem];
    r.rerender(view(items));
  }
  const perWord = (performance.now() - t0) / N;
  expect(perWord).toBeLessThan(12);
});
