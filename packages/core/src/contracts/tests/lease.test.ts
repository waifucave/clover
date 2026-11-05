// Runs the Lease conformance suite against FakeLeaseAuthority.
import { runLeaseConformance } from "../conformance/lease";
import { FakeLeaseAuthority } from "../fakes/lease";

runLeaseConformance((...args) => new FakeLeaseAuthority(...args));
