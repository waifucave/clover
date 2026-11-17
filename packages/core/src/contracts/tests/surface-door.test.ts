// Runs the SurfaceDoor conformance suite against FakeSurfaceDoor.
import { runSurfaceDoorConformance } from "../conformance/surface-door";
import { FakeSurfaceDoor } from "../fakes/surface-door";

runSurfaceDoorConformance((...args) => new FakeSurfaceDoor(...args));
