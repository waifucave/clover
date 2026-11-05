// The messaging lane, as one import site — and one composite factory, because the directory and the
// router are two halves of one thing.
//
// `createRuntimeMessaging` exists for the circularity the two halves genuinely have: the directory
// renders a `ChildLike` for every child row, and the two doors that interface requires (`steer`,
// `resume`) are the ROUTER's to answer — while the router resolves every address through the
// DIRECTORY. Building them separately and wiring them afterwards is possible (both factories are
// exported), but it is the kind of two-step a caller gets wrong once and then debugs for an hour, so
// the composed door is the one the package leads with.
export { createRuntimeDirectory } from "../directory/directory";
export type { DirectorySnapshot, RuntimeDirectoryHandle, RuntimeDirectoryOptions } from "../directory/directory";
export type { RuntimeDirectoryRecoveryHooks, RuntimeDirectoryRetention } from "../directory/recovery";
export { entryToChildLike, entryToListedRuntimeObject, entryToListedRuntimeObjectList, isListableFrom, isLiveStatus, isResolvableFrom, mergeAdapterOwnedFields, owningSessionIdOf, parentAddressOf, sessionAddressOf } from "../directory/entries";

export { createGlobalMessaging, deriveMessageId } from "./router";
export type { GlobalMessagingContext, GlobalMessagingHandle, GlobalMessagingOptions, ReplyRequest } from "./router";
export { createWinterMessagingAdapter } from "./winter-adapter";
export type { WinterMessagingAdapter, WinterMessagingAdapterDeps } from "./winter-adapter";
export { createDispatchingAdapter } from "./dispatch";
export type { DispatchDeps, RouterMessagingAdapter } from "./dispatch";
export { createInboundPolicy } from "./inbound";
export type { InboundPolicy, InboundPolicyDeps, InboundPolicyHooks, InboundVerdict } from "./inbound";
export { createAttachedSessionRegistry } from "./sessions";
export type { AttachedSession, AttachedSessionRegistry, AttachedWinterSession, LiveSessionStatus } from "./sessions";
export { renderAttributedTurn, renderOwnerQualifiedTurn, UnattributableSenderError } from "./attribution";
// THE MESSAGING TOOL HANDLERS ARE NOT HERE ANY MORE (R-8-1): `createMessagingToolHandlers`, the
// acceptors, the native schemas and `callerAddress` all live in `@waifucave/clover-agent-sdk/tools`,
// declared once for both hosts. This lane's contribution is the PORT they run over — the router's
// `GlobalMessagingHandle` satisfies the SDK's `MessagingToolPort` structurally (ruling P-3), so it is
// passed straight in with no adapter. The router re-exports none of it (ruling P-7).

import { createRuntimeDirectory, type RuntimeDirectoryHandle, type RuntimeDirectoryOptions } from "../directory/directory";
import type { SeamContext } from "../seams/context";
import { createGlobalMessaging, type GlobalMessagingHandle, type GlobalMessagingOptions } from "./router";
import type { WinterColdResumeRunHomes } from "./winter-adapter";

export interface RuntimeMessaging {
  directory: RuntimeDirectoryHandle;
  messaging: GlobalMessagingHandle;
}

/**
 * The directory and the router, built together and wired to each other.
 *
 * THE ONE WIRE THAT IS EASY TO MISS: the directory's `ChildLike` view delivers through the ROUTER, so
 * a caller that used `ChildLike.steer`/`resume` (the router core never does — see `entryToChildLike`)
 * reaches the child's own runtime adapter rather than a stub. It is a late binding on purpose: the
 * router does not exist yet when the directory is constructed, so the hook closes over a variable
 * that is assigned one line later.
 */
export function createRuntimeMessaging(
  context: SeamContext,
  options: { directory?: RuntimeDirectoryOptions; messaging?: GlobalMessagingOptions } = {},
  internal: { winterRunHomes?: WinterColdResumeRunHomes } = {},
): RuntimeMessaging {
  let messaging: GlobalMessagingHandle | undefined;
  const directory = createRuntimeDirectory(context, {
    ...(options.directory ?? {}),
    deliverToChild: async (entry, message) => {
      /* c8 ignore next */
      if (messaging === undefined) throw new Error("clover runtime host: the messaging router is not built yet"); // unreachable: assigned on the next line, and nothing delivers during construction
      return messaging.deliver({ ...message, to: entry.parsed, toGeneration: entry.generation });
    },
  });
  messaging = createGlobalMessaging({ ...context, directory }, options.messaging ?? {}, internal);
  return { directory, messaging };
}
