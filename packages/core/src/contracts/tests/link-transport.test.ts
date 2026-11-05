// Runs the LinkTransport conformance suite against FakeLinkNetwork.
import { runLinkTransportConformance } from "../conformance/link-transport";
import { FakeLinkNetwork } from "../fakes/link-transport";

runLinkTransportConformance((...args) => new FakeLinkNetwork(...args));
