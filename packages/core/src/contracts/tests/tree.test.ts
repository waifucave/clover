// Runs the Tree conformance suite against FakeTree.
import { runTreeConformance } from "../conformance/tree";
import { FakeTree } from "../fakes/tree";

runTreeConformance((...args) => new FakeTree(...args));
