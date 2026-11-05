// A pretend UI runtime for the gallery and the tests: it draws what the core's sealed frames and
// MCP Apps views would, so the conversation's layout around them can be seen. The text in a sealed
// field here is the MOCK CORE's, handed to the frame, never to the conversation plugin — exactly the
// split the real runtime keeps (spec §5.5).
import { createContext, useContext, type ReactNode } from "react";
import type { SealedField, UiRuntime } from "../client/sdk";

export type SealedCardData = Partial<Record<SealedField, string>>;

const CardContext = createContext<SealedCardData | undefined>(undefined);

export interface MockRuntimeOptions {
  /** What each card's sealed fields say, by card id. */
  cards?: Record<string, SealedCardData>;
  /** What each MCP Apps page draws, by tool call id. */
  apps?: Record<string, { resourceUri: string; body: ReactNode }>;
  onApprove?: (cardId: string) => void;
  onDeny?: (cardId: string) => void;
}

export function mockRuntime(options: MockRuntimeOptions = {}): UiRuntime {
  const cards = options.cards ?? {};
  const apps = options.apps ?? {};
  return {
    Card: ({ id, children, className }) => (
      <CardContext.Provider value={{ ...cards[id] }}>
        <div className={className} data-sealed-card={id}>
          {children}
        </div>
      </CardContext.Provider>
    ),
    CardField: ({ name, className }) => <MockField name={name} className={className} />,
    CardApprove: ({ className }) => <MockButton kind="approve" className={className} onPress={options.onApprove} />,
    CardDeny: ({ className }) => <MockButton kind="deny" className={className} onPress={options.onDeny} />,
    AppView: ({ call, className }) => {
      const app = apps[call];
      return (
        <div className={className} data-app-view={call}>
          <div className="mock-app">
            <div className="mock-app__bar">{app?.resourceUri ?? "ui://"}</div>
            <div className="mock-app__body">{app?.body ?? null}</div>
          </div>
        </div>
      );
    },
  };
}

function MockField({ name, className }: { name: SealedField; className?: string }) {
  const card = useContext(CardContext);
  const text = card?.[name];
  if (text === undefined) return null;
  return (
    <span className={className} data-sealed-field={name}>
      <span className="mock-sealed" data-field={name}>
        {text}
      </span>
    </span>
  );
}

function MockButton({ kind, className, onPress }: { kind: "approve" | "deny"; className?: string; onPress?: (cardId: string) => void }) {
  return (
    <span className={className} data-sealed-button={kind}>
      <span
        className="mock-sealed-button"
        data-kind={kind}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          const card = (e.currentTarget.closest("[data-sealed-card]") as HTMLElement | null)?.dataset.sealedCard;
          if (card) onPress?.(card);
        }}
      >
        {kind === "approve" ? "Approve" : "Deny"}
      </span>
    </span>
  );
}

/** A tiny bar chart, standing in for an MCP Apps page's content. */
export function MockChart({ bars }: { bars: { label: string; value: number }[] }): ReactNode {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="mock-chart">
      {bars.map((b) => (
        <div key={b.label} className="mock-chart__col">
          <div className="mock-chart__bar" style={{ height: `${Math.round((b.value / max) * 100)}%` }} />
          <div className="mock-chart__label">{b.label}</div>
        </div>
      ))}
    </div>
  );
}
