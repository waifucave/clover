// The core events a part may hear through `useCore().on(type)`, and the area each is sent in: `on` subscribes the
// part's plugin's connection to that area, and only for these. An event not listed here never reaches a part that way
// (the bundled parts' events test, packages/core/src/plugin-host/tests/bundled-part-events.test.ts, checks each part
// listens only for events it can hear). Plain data, with no React, so a test can read it.
export const EVENT_AREAS: Readonly<Record<string, string>> = {
  ui_settings_changed: "app", card_pending: "approvals", card_resolved: "approvals", pairing_changed: "devices", device_changed: "devices",
  session_changed: "sessions", bot_changed: "sessions", computer_changed: "computers", plugin_changed: "plugins", plugin_card_note: "plugins",
};
