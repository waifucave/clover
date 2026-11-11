// Two buttons for the bot's header (`bot.header.action`): the bot's own plugin hides Pin in its tab.
import { createElement } from "react";

export function WaveButton() {
  return createElement("button", { type: "button", className: "acc-mover-button" }, "Wave");
}

export function PinButton() {
  return createElement("button", { type: "button", className: "acc-mover-button" }, "Pin");
}
