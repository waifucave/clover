// Runs the ApprovalBroker conformance suite against FakeApprovalBroker.
import { runApprovalBrokerConformance } from "../conformance/approval-broker";
import { FakeApprovalBroker } from "../fakes/approval-broker";

runApprovalBrokerConformance((...args) => new FakeApprovalBroker(...args));
