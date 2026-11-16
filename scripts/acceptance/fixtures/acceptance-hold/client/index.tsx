// The hold clause's page: a button to press and hold, and `window.__holdSend(to, text)` the run calls later (no click of the
// page's own and no activation behind it): it sends the user's words with `useUserSend` and writes what came of it.
import { useEffect } from "react";
import { useUserSend } from "@waifucave/moss-plugin-sdk/ui";

export function HoldApp() {
  const send = useUserSend();
  useEffect(() => {
    (globalThis as unknown as { __holdSend: (to: unknown, text: string) => Promise<string> }).__holdSend = async (to, text) => {
      if (send === undefined) return "no hook";
      try {
        await send(to as never, text);
        return "sent";
      } catch (e) {
        return `refused: ${String(e).slice(0, 160)}`;
      }
    };
  }, [send]);
  return <button type="button" data-hold="button" style={{ display: "block", width: "100%", height: 120, fontSize: 20 }}>Hold me</button>;
}
