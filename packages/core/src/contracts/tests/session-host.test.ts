// Runs the SessionHost conformance suite against FakeSessionHost.
import { runSessionHostConformance } from "../conformance/session-host";
import { FakeSessionHost } from "../fakes/session-host";

runSessionHostConformance((...args) => new FakeSessionHost(...args));
