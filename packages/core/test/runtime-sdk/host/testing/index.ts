// The FULL test harness, as one import site: `import { … } from "../../../../src/runtime-sdk/host/../src/testing/index"`.
// INTERNAL ONLY, still — this file is not `package.json`'s `./testing` entry (that's `./host.ts`, a
// narrower barrel; see its header). Everything here reaches a DEV dependency
// (`@yanlinglabs/winter-conformance`, `@yanlinglabs/winter-provider-conformance`) that a consumer of
// the published subpath never installs; `./conformance.ts` and `./fakes.ts` import their peer LAZILY
// (a dynamic `import()` inside each function body) so this barrel's own evaluation does not throw for
// the tests here, but that laziness is a RUNTIME fix only — it does not make either file's TYPES safe
// for a consumer without the peer, which is the whole reason `./host.ts` exists as a separate,
// narrower, always-resolvable barrel rather than this one being published directly.
export { anthropicFake, openaiResponsesFake, requestsTo, withLoopbackFake } from "./fakes";
export type { FakeRoute, FakeServer, RecordedRequest, StartFakeOptions } from "./fakes";
export { createFakeKeychain, withHermeticHomes, withTempDir } from "./hermetic";
export type { FakeKeychain } from "./hermetic";
export { createFakeWinterPeer } from "./peers";
export type { FakeWinterPeer, FakeWinterPeerOptions, RecordedQueryCall } from "./peers";
