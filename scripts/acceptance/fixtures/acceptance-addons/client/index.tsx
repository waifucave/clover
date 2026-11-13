// The add-ons fixture's one piece of UI: a line in the shell's status bar with a button that asks the user through the
// plugin's own question card from the component (`confirmCard`), and says what came back: `data-answer` is "yes <card>"
// or "no <card>", or "refused: <why>".
import { useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export function AddonsAsk() {
  const api = usePluginApi();
  const [answer, setAnswer] = useState("none");
  const ask = () => {
    setAnswer("asking");
    void (api.confirmCard ? api.confirmCard("May the stamps page keep its window open?") : Promise.reject(new Error("no confirmCard"))).then(
      (r) => setAnswer(`${r.allowed ? "yes" : "no"} ${r.card}`),
      (e: unknown) => setAnswer(`refused: ${String(e).slice(0, 120)}`),
    );
  };
  return <button type="button" data-addons="ask" data-answer={answer} onClick={ask}>Stamps: ask</button>;
}
