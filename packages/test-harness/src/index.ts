// Clover's test harness (plan §3, lane M): what a test needs to run Clover's pieces for real without touching
// the machine it runs on. docs/clover-layout.md says how a package uses it. This index loads the daemon (core);
// a test that needs only one piece imports its subpath (`@waifucave/clover-test-harness/workers`, `/signin-stub`,
// `/homes`, `/secrets`, `/app-client`), which does not.
export { DAEMON_PLATFORMS, daemonSupported } from "./platform";
export { assertSafeTestHome, makeTempHome, PROTECTED_HOME_PREFIXES, UnsafeHomeError, type TempHome } from "./homes";
export {
  assertThrowawayService, createThrowawaySecretStore, PRIVATE_SECRET_SERVICE_ENV, REAL_SECRET_SERVICES, secretBackend,
  TEST_SERVICE_PREFIX, throwawaySecretStoreAvailable, type SecretBackend, type ThrowawaySecretStore,
} from "./secrets";
export { FakeAppClient, type FakeAppClientOptions, type Notification, type RpcError } from "./app-client";
export {
  linkTransportFake, startDaemons, startTestDaemon, testDaemonSettings, UNLINKED,
  type DaemonCluster, type HarnessDaemon, type HarnessLink, type TestDaemonOptions,
} from "./daemons";
export { bundleWorker, miniflareOptions, readWranglerConfig, startWorker, SUPPORTED_WRANGLER_KEYS, type RunningWorker, type WranglerConfig } from "./workers";
export { signHs256, startSignInStub, verifyHs256, type SignInStub, type StubProvider, type StubUser } from "./signin-stub";
