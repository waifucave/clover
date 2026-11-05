// The session host: what the daemon needs around the agent SDK, now that the router is gone.
//
// Spec §3.3: `winter-runtime-sdk` (the router) is archived, and the daemon embeds the SDK directly.
// The router was a thin `query()` pass-through plus four things the daemon still needs, which live
// here, in core, from router 0.0.16 (`yanlingLabs/winter-runtime-sdk` @ c542420, the release commit
// of the version the daemon last installed):
//
//   * run homes (`run-home/`): the per-run folder every generation runs on (WS-21);
//   * the runtime directory and the messaging router (`directory/`, `messaging/`, `seams/`):
//     who is live, addresses, and `SendMessage`/`ListAgents` between sessions;
//   * the shared transcript store (`store/`): the model-switch review and crash recovery;
//   * the selection record (`selection/`): the `RuntimeSelection` a session persists.
//
// The router's `createRuntimeSdk` door is `createSessionHost` (`session-host.ts`): the run home applied,
// then the SDK's own `query()`. What the router did not keep: its `peers` injection, its version matrix
// over the injected peer, selections carried in `Options.runtime` and its capability-server merge. The
// daemon imports the SDK itself (`create.ts`), checks one version lock (`embedded.ts`'s
// `embeddedVersionCheck`) and hands each session its own `mcpServers`.
export { buildRunHome } from "./run-home/build";
export { escapeRulePath, fsRootAnchored, protectedPathRules, PROTECTED_ITEM_DIRS, RUN_HOME_CONTRACT_VERSION, RUN_HOME_PERSISTENT_ENTRIES, sdkHomeOf } from "./run-home/types";
export { escapeSandboxGlobPath } from "./run-home/settings";
export type { RunHome, RunHomeBrand, RunHomeFor, RunHomeForContext, RunHomeInput, RunHomeOutcome, RunHomeReport, RunLeg, RunMode } from "./run-home/types";
export type { RecoveryReport, RecoveryTranscriptOutcome } from "./run-home/exit";
export { RunHomeError } from "./run-home/errors";
export type { RunHomeErrorCode } from "./run-home/errors";
export { reconcileLocalWriteRoot } from "./store/reconcile";
export type { ReconcileReport, TailComparison, TranscriptReconcileOutcome } from "./store/reconcile";

export { createSessionHost } from "./session-host";
export type { HostQueryOptions, HostSdk, SessionHost, SessionHostOptions } from "./session-host";

export { isSelectionRefusal, selectChildRuntime, selectRuntime, SelectionRefusedError } from "./selection/runtime-selection";
export type { ChildSelectionInput, CredentialPresence, RuntimeKind, RuntimeSelection, SelectionAlternative, SelectionInput, SelectionRefusal } from "./selection/runtime-selection";
export { CHILD_PROVIDER_UNAVAILABLE, resumeChildSelection, selectChildRuntimePairing } from "./selection/child-runtime";
export type { ChildResumeOutcome, ChildRuntimePairing } from "./selection/child-runtime";
export type { ProviderAuthView, SelectionAuthFamily, SelectionVersions } from "./selection/runtime-selection";
export { D14_CLAUDE_OAUTH_APPROVED_DEFAULT, SELECTION_RULES, UNKNOWN_VERSION, reviewPersistedSelection, ruleIdOf, selectionVersionsFrom } from "./selection/select-runtime";
export type { SelectionReview, SelectionRuleId } from "./selection/select-runtime";

export { RESUME_STAGING_PREFIX, isResumeStagingRoot, resumeStagingRoot } from "./vendor-paths";
export { EXECUTION_INDIRECTION_ENV_NAMES, EXECUTION_INDIRECTION_ENV_PREFIXES, isExecutionIndirectionVariable } from "./run-home/env-refusals";
export { TRAFFIC_OPT_OUT_VARIABLES, TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "./run-home/env-refusals";

export * from "./seams/index";

export { NotImplementedYet, RuntimeLaunchInputError, RuntimeSdkDisposedError, RuntimeSdkError, UnaddressableEntryError } from "./errors";

export { renderAttributedTurn } from "./messaging/index";
export { createRuntimeMessaging, createAttachedSessionRegistry } from "./messaging/index";
export type {
  AttachedSession, AttachedSessionRegistry, AttachedWinterSession,
  DirectorySnapshot, GlobalMessagingHandle, GlobalMessagingOptions, ReplyRequest, RouterMessagingAdapter,
  RuntimeDirectoryHandle, RuntimeDirectoryOptions, RuntimeDirectoryRecoveryHooks,
} from "./messaging/index";

export { defaultEndpointResolver } from "./default-endpoint-resolver";
export { SwitchReviewError } from "./store/review-switch";
export type { SwitchReviewerDeps, SwitchReviewerHandle } from "./store/review-switch";
