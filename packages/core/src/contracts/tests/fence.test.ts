// Runs the Fence conformance suite against FakeFence.
import { runFenceConformance } from "../conformance/fence";
import { FakeFence } from "../fakes/fence";

// The fake compares path strings, so the real-path case is lane C's real fence's to pass.
runFenceConformance((...args) => new FakeFence(...args), { pending: ["real-paths"] });
