// Runs the HostSupervisor conformance suite against FakeHostSupervisor.
import { runHostSupervisorConformance } from "../conformance/host-supervisor";
import { FakeHostSupervisor } from "../fakes/host-supervisor";

runHostSupervisorConformance((...args) => new FakeHostSupervisor(...args));
