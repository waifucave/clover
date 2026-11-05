// Every settings state the gallery shows.
import { useState } from "react";
import { LanguageChooser } from "../client/LanguageChooser";
import { SettingsModal } from "../client/SettingsModal";
import type { SettingsSection } from "../client/types";
import { LANGUAGES, VALUES } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

export function SettingsDemo({ start }: { start: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(start);
  return (
    <SettingsModal section={section} onSection={setSection} onClose={noop} values={VALUES} onChange={noop} onOpenLanguage={noop} onOpenPluginManager={noop} onRemoveDevice={noop} />
  );
}

export const settingsStories: Story[] = [
  { id: "settings/code", title: "Settings: Code", width: 1060, height: 740, render: () => <SettingsDemo start="code" /> },
  { id: "settings/appearance", title: "Settings: Appearance", notes: "Theme, text size and the language, which opens the chooser.", width: 1060, height: 740, render: () => <SettingsDemo start="appearance" /> },
  { id: "settings/customize", title: "Settings: Customize", notes: "The theme plugin, and each plugin with its switch.", width: 1060, height: 740, render: () => <SettingsDemo start="customize" /> },
  { id: "settings/later", title: "A page still to come", width: 1060, height: 740, render: () => <SettingsDemo start="usage" /> },
  {
    id: "settings/languages",
    title: "The language chooser",
    notes: "Each language named in itself and in the app's language; the current one checked.",
    width: 900,
    height: 580,
    render: () => <LanguageChooser languages={LANGUAGES} current="en-US" onPick={noop} onClose={noop} />,
  },
];
