// A bot session's `AskUserQuestion` (spec §5.5: the question is the bot's; the user, or a plugin that shows it, answers
// it with `session.answer`). Owner: lane D.
//
// The question goes through the daemon's existing machinery, as a code or chat session's does: the runtime's
// `canUseTool` sees `AskUserQuestion`, `askUserQuestionBridge` records `question_asked` in the session's log (so the
// session's view counts it in `needsYou`, and every client sees it), parks on the `QuestionBroker`, and gives the
// answers back to the model as the tool's `updatedInput.answers`; `question_resolved` follows. `session.answer`
// resolves the broker. Any other tool call goes on to the session's own `canUseTool`.
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { NewSessionEvent } from "@waifucave/clover-protocol";
import { QuestionBroker } from "../agent/questions";
import { ASK_USER_QUESTION_TOOL, askUserQuestionBridge } from "../runtime-sdk/question-bridge";
import type { DurableSessionHost } from "../sessions/durable-host";

export interface BotQuestions {
  readonly broker: QuestionBroker;
  /** The session's `canUseTool` with its `AskUserQuestion` asked of the user; any other call goes to `inner`. */
  canUseTool(sessionId: string, inner: CanUseTool): CanUseTool;
}

export function botQuestions(o: { host: Pick<DurableSessionHost, "get" | "recordCore">; warn?: (message: string) => void }): BotQuestions {
  const broker = new QuestionBroker();
  return {
    broker,
    canUseTool(sessionId, inner) {
      const bridge = askUserQuestionBridge({
        sessionId, threadId: sessionId, questions: broker,
        // The question and its answer go in the session's own log, as the driver's other events do.
        emit: (event: NewSessionEvent) => {
          if (o.host.get(sessionId) === undefined) return;
          o.host.recordCore(sessionId, event as unknown as { type: string; [key: string]: unknown });
        },
        ...(o.warn === undefined ? {} : { log: { info: () => {}, error: (message: string) => o.warn!(`${sessionId}: ${message}`) } }),
      });
      return (toolName, input, opts) => {
        if (toolName !== ASK_USER_QUESTION_TOOL) return inner(toolName, input, opts);
        return bridge(opts.toolUseID, input, { signal: opts.signal, ...(opts.agentID === undefined ? {} : { agentID: opts.agentID }) });
      };
    },
  };
}
