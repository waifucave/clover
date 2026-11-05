// The manifest's TypeScript types, inferred from its schema (`schema.ts`), so the types, the JSON Schema and the
// validator never drift apart (spec §5.6 "from one source").
import type { z } from "zod";
import type {
  AgentBackendSchema, AgentDefSchema, AuthSchema, BotSchema, CommandSchema, ComputerProviderSchema, ComputerSchema,
  ContributionsSchema, DeclaresSchema, HookSchema, LocaleEntrySchema, ManifestSchema, McpServerSchema, ModelSchema,
  PointDeclSchema, ServiceSchema, SettingSchema, ThemeEntrySchema, TriggerSchema, UiSchema, VoiceSchema,
} from "./schema";

export type Manifest = z.infer<typeof ManifestSchema>;
export type Contributions = z.infer<typeof ContributionsSchema>;
export type PointDecl = z.infer<typeof PointDeclSchema>;
export type Declares = z.infer<typeof DeclaresSchema>;
export type Auth = z.infer<typeof AuthSchema>;
export type Setting = z.infer<typeof SettingSchema>;
export type Bot = z.infer<typeof BotSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type AgentDef = z.infer<typeof AgentDefSchema>;
export type AgentBackend = z.infer<typeof AgentBackendSchema>;
export type Hook = z.infer<typeof HookSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type ComputerProvider = z.infer<typeof ComputerProviderSchema>;
export type Computer = z.infer<typeof ComputerSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type ThemeEntry = z.infer<typeof ThemeEntrySchema>;
export type LocaleEntry = z.infer<typeof LocaleEntrySchema>;
export type Ui = z.infer<typeof UiSchema>;

/** The entry type each core point's `contributes` key holds, one entry at a time. */
export interface CoreEntries {
  bot: Bot;
  models: Model;
  mcpServers: McpServer & { name: string };
  skills: string;
  agents: string | AgentDef;
  agentBackends: AgentBackend;
  hooks: Hook;
  commands: Command;
  triggers: Trigger;
  voices: Voice;
  computerProviders: ComputerProvider;
  computer: Computer;
  relays: Service;
  notifiers: Service;
  companions: Service;
  themes: ThemeEntry;
  locales: LocaleEntry;
  ui: Ui;
}
