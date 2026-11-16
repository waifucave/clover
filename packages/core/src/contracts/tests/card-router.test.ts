// Runs the CardRouter conformance suite against FakeCardRouter.
import { runCardRouterConformance } from "../conformance/card-router";
import { FakeCardRouter } from "../fakes/card-router";

runCardRouterConformance((...args) => new FakeCardRouter(...args));
