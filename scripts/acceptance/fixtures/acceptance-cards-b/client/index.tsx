// The second card fixture: a plugin with `approvals` and no bot. Its badge is always mounted, so it shows both that the
// part is there and that the core answered its card list (data-listed), and every card id it was told of (data-ids),
// by the event and by the list.
import { useEffect, useState } from "react";
import { useApprovals, usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export function CardsBMain() {
  return <p data-cards-b="main">Acceptance cards B</p>;
}

export function CardsBBadge() {
  const { cards } = useApprovals();
  const api = usePluginApi();
  const [listed, setListed] = useState("asking");
  const [listIds, setListIds] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => void api.approvals?.pending().then(
      (c) => { if (live) { setListed("answered"); setListIds(c.map((x) => x.id).join(",")); } },
      (e: unknown) => { if (live) setListed(`refused: ${String(e).slice(0, 80)}`); },
    );
    read();
    const timer = setInterval(read, 700);
    return () => { live = false; clearInterval(timer); };
  }, [api]);
  return <span data-cards-b="badge" data-mounted="yes" data-listed={listed} data-ids={[...cards.map((c) => c.id), ...listIds.split(",").filter(Boolean)].join(",")}>•</span>;
}
