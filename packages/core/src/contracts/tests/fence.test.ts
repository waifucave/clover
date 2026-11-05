// Runs the Fence conformance suite against FakeFence.
import { runFenceConformance } from "../conformance/fence";
import { FakeFence } from "../fakes/fence";

runFenceConformance((...args) => new FakeFence(...args));
