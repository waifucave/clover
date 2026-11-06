// The seams, as one import site.
//
// SPINE-OWNED (P7b Task 1). Every lane implements behind these signatures and none of them edits this
// directory: a change here is a NEEDS_CONTEXT with the exact diff, because four lanes are compiling
// against it at the same time. The one file with a scheduled edit is `messaging-contract.ts`, whose
// header names the flip and who makes it.
export type { SeamContext, SeamContextWithDirectory } from "./context";
export type { RuntimeDirectory, DirectoryResolution, DirectoryResolutionContext, RuntimeDirectoryRecovery, RuntimeDirectoryRecoveryStep } from "./directory";
export type {
  CursorStore,
  DeliveryRecord,
  DeliveryRecordStore,
  HeldMessageRecord,
  IdleSubscriptionRecord,
  IdleSubscriptionStore,
  MailboxStore,
  NameLeaseRecord,
  NameLeaseStore,
  RuntimeDirectoryEntry,
  RuntimeDirectoryStore,
  RuntimeTransport,
} from "./directory-store";
export { createInMemoryRuntimeDirectoryStore } from "./directory-store";
export type { GlobalMessaging, SendMessageRequest } from "./global-messaging";
export type { KeychainSeam } from "./keychain";
export type {
  DeliveryOutcome,
  GlobalAgentMessage,
  ListedRuntimeObject,
  PermissionClassLabel,
  RuntimeAddress,
  RuntimeMessagingAdapter,
  RuntimeObjectKind,
  SerializedRuntimeAddress,
} from "./messaging-contract";
// WS-23: the switch review replaced the handoff barrier seam; the official adapter's and the
// materialized-resume decorator's seams went with the official runtime.
export type { SwitchReviewer } from "./review-switch";
