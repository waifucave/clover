// Every settings state the gallery shows.
import { useState } from "react";
import { LanguageChooser } from "../client/LanguageChooser";
import { SettingsModal } from "../client/SettingsModal";
import type { SettingsSection } from "../client/types";
import { LANGUAGES, VALUES } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** Settings over the gallery's fixtures. A host that draws the cards Settings raises passes their doors. */
export function SettingsDemo({ start, onRequestLevel = noop, onRemoveDevice = noop }: { start: SettingsSection; onRequestLevel?: () => void; onRemoveDevice?: () => void }) {
  const [section, setSection] = useState<SettingsSection>(start);
  return (
    <SettingsModal
      section={section}
      onSection={setSection}
      onClose={noop}
      values={VALUES}
      onChange={noop}
      onOpenLanguage={noop}
      onOpenPluginManager={noop}
      onOpenPluginLogs={noop}
      onRequestLevel={onRequestLevel}
      onRemoveDevice={onRemoveDevice}
    />
  );
}

export const settingsStories: Story[] = [
  { id: "settings/appearance", title: "Settings: Appearance", notes: "Light or dark, the theme (themes are plugins), text size, and the language, which opens the chooser.", width: 1060, height: 820, render: () => <SettingsDemo start="appearance" /> },
  { id: "settings/plugins", title: "Settings: Plugins", notes: "Each plugin with its state, the OKs it runs with, its logs and its switch (spec §5.8).", width: 1060, height: 820, render: () => <SettingsDemo start="plugins" /> },
  { id: "settings/levels", title: "Settings: Levels", notes: "Each computer's level (spec §9.1). A pick raises a sealed card, and Settings closes for it; Laptop's change, asked from another device, still waits for its card.", width: 1060, height: 820, render: () => <SettingsDemo start="levels" /> },
  { id: "settings/devices", title: "Settings: Devices", notes: "The paired devices; removing one asks on a card first.", width: 1060, height: 820, render: () => <SettingsDemo start="devices" /> },
  { id: "settings/later", title: "A page still to come", width: 1060, height: 820, render: () => <SettingsDemo start="usage" /> },
  {
    id: "settings/languages",
    title: "The language chooser",
    notes: "Each language named in itself and in the app's language; the current one checked.",
    width: 900,
    height: 580,
    render: () => <LanguageChooser languages={LANGUAGES} current="en-US" onPick={noop} onClose={noop} />,
  },
];
