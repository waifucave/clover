// The HostSupervisor conformance suite against the engine's real supervisor (lane HS).
import { runHostSupervisorConformance } from "../../contracts/conformance/host-supervisor";
import { EngineHostSupervisor } from "../supervisor";

runHostSupervisorConformance((opts) => new EngineHostSupervisor(opts));
