// A pretend UI runtime for the gallery and the tests: it draws what the core's sealed frames and
// MCP Apps views would, so the conversation's layout around them can be seen. The text in a sealed
// field and an option's label here are the MOCK CORE's, handed to the frame, never to the
// conversation plugin — exactly the split the real runtime keeps (spec §5.5).
import { createContext, useContext, type ReactNode } from "react";
import type { CardButtonProps, SealedField, UiRuntime } from "../client/sdk";

export type SealedCardData = Partial<Record<SealedField, string>>;

const CardContext = createContext<{ id: string; data: SealedCardData } | undefined>(undefined);

/** The mock core's option labels, by option id. */
const LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  deny: "Deny",
  approve: "Approve",
  open_link: "Open link",
  decline: "Decline",
};

export interface MockRuntimeOptions {
  /** What each card's sealed fields say, by card id. */
  cards?: Record<string, SealedCardData>;
  /** What each MCP Apps page draws, by tool call id. */
  apps?: Record<string, { resourceUri: string; body: ReactNode }>;
  onApprove?: (cardId: string, option?: string) => void;
  onDeny?: (cardId: string, option?: string) => void;
}

export function mockRuntime(options: MockRuntimeOptions = {}): UiRuntime {
  const cards = options.cards ?? {};
  const apps = options.apps ?? {};
  return {
    Card: ({ id, children }) => (
      <CardContext.Provider value={{ id, data: { ...cards[id] } }}>
        <div className="mock-card" data-sealed-card={id}>
          {children}
        </div>
      </CardContext.Provider>
    ),
    CardField: ({ name, lines }) => <MockField name={name} lines={lines} />,
    CardApprove: (props) => <MockButton kind="approve" {...props} onPress={options.onApprove} />,
    CardDeny: (props) => <MockButton kind="deny" {...props} onPress={options.onDeny} />,
    AppView: ({ call }) => {
      const app = apps[call.callId];
      return (
        <div className="mock-app" data-app-view={call.callId}>
          <div className="mock-app__bar">{app?.resourceUri ?? "ui://"}</div>
          <div className="mock-app__body">{app?.body ?? null}</div>
        </div>
      );
    },
  };
}

function MockField({ name, lines }: { name: SealedField; lines?: number }) {
  const card = useContext(CardContext);
  const text = card?.data[name];
  if (text === undefined) return null;
  return (
    <span className="mock-sealed" data-sealed-field={name} data-field={name} data-lines={lines}>
      {text}
    </span>
  );
}

function MockButton({
  kind,
  option,
  onPress,
}: CardButtonProps & { kind: "approve" | "deny"; onPress?: (cardId: string, option?: string) => void }) {
  const card = useContext(CardContext);
  const label = (option && LABELS[option]) ?? (kind === "approve" ? LABELS.approve : LABELS.deny);
  return (
    <span
      className="mock-sealed-button"
      data-sealed-button={kind}
      data-option={option}
      data-kind={kind}
      data-always={option === "allow_always" || undefined}
      role="button"
      tabIndex={0}
      onClick={() => card && onPress?.(card.id, option)}
    >
      {label}
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
