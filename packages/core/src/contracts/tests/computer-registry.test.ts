// Runs the ComputerRegistry conformance suite against FakeComputerRegistry.
import { runComputerRegistryConformance } from "../conformance/computer-registry";
import { FakeComputerRegistry } from "../fakes/computer-registry";

runComputerRegistryConformance((...args) => new FakeComputerRegistry(...args));
