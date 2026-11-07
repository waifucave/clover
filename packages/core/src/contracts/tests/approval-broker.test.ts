// Runs the ApprovalBroker conformance suite against FakeApprovalBroker.
import { runApprovalBrokerConformance, runCallCardTableConformance } from "../conformance/approval-broker";
import { FakeApprovalBroker, fakeCallCardRenderer } from "../fakes/approval-broker";

runApprovalBrokerConformance((...args) => new FakeApprovalBroker(...args));
runCallCardTableConformance(fakeCallCardRenderer);
