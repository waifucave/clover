// Lane B's ComputerRegistry conformance suite, against the real registry.
import { runComputerRegistryConformance } from "../../src/contracts/conformance/computer-registry";
import { CoreComputerRegistry } from "../../src/computers/registry";

runComputerRegistryConformance((opts) => new CoreComputerRegistry(opts));
