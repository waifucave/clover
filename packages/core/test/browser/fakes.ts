// The browser's fakes for the core's tests: the app's side and lane D's grants.
import {
  AGENT_VIEWPORT, partitionFor, type AppTabCommand, type AppTabPort, type BrowserNetworkConfig, type PersonsBrowserCard,
  type PersonsBrowserGrants, type TabOwner, type TabPlace, type TabView,
} from "../../src/browser";

/** The app's side, as a test sees it: every command recorded, tabs kept as the app would report them. */
export class FakeApp implements AppTabPort {
  readonly commands: { id: string; command: AppTabCommand }[] = [];
  readonly tabs = new Map<string, TabView>();
  answers: Partial<Record<AppTabCommand["kind"], unknown>> = {};
  fail?: Error;

  async open(args: { id: string; owner: TabOwner; url?: string; place: TabPlace }): Promise<TabView> {
    if (this.fail) throw this.fail;
    const view: TabView = {
      id: args.id, computer: "Studio", owner: args.owner, partition: partitionFor(args.owner), url: args.url ?? "about:blank",
      title: "", place: args.place, viewport: { ...AGENT_VIEWPORT }, loading: args.url !== undefined, heldByUser: false,
    };
    this.tabs.set(args.id, view);
    return view;
  }

  async command(id: string, command: AppTabCommand): Promise<unknown> {
    if (this.fail) throw this.fail;
    this.commands.push({ id, command });
    if (command.kind === "close") this.tabs.delete(id);
    return this.answers[command.kind] ?? null;
  }

  async list(): Promise<TabView[]> {
    return [...this.tabs.values()];
  }

  readonly configs: BrowserNetworkConfig[] = [];
  async configure(config: BrowserNetworkConfig): Promise<void> {
    if (this.fail) throw this.fail;
    this.configs.push(config);
  }
}

/** Lane D's grants as a test plays them: the card's answer per session, and every card asked. */
export class FakeGrants implements PersonsBrowserGrants {
  readonly held = new Set<string>();
  readonly asked: { session: string; card: PersonsBrowserCard }[] = [];
  answer = false;
  has(session: string): boolean {
    return this.held.has(session);
  }
  async ensure(session: string, card: PersonsBrowserCard): Promise<boolean> {
    if (this.held.has(session)) return true;
    this.asked.push({ session, card });
    if (this.answer) this.held.add(session);
    return this.answer;
  }
}
