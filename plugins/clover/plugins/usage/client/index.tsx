// The usage plugin's client entry (spec §12): the components its manifest's `ui` entries name, and the model the
// island's other surfaces and the phone can reuse.

export { UsageTabEntry, UsageSection, UsageHostContext, type UsageHost, type UsageEntryProps } from "../src/ui/host";
export { UsageTab, type UsageTabProps } from "../src/ui/UsageTab";
export { UsageView, type UsageViewProps } from "../src/ui/UsageView";
export { ensureUsageStyles, USAGE_CSS } from "../src/ui/styles";
export { memoryUsage, type MemoryUsage } from "../src/fake";
export * from "../src/model/usage";
