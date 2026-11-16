// Runs the ReleaseHome conformance suite against FakeReleaseHome.
import { runReleaseHomeConformance } from "../conformance/release-home";
import { FakeReleaseHome } from "../fakes/release-home";

runReleaseHomeConformance((...args) => new FakeReleaseHome(...args));
