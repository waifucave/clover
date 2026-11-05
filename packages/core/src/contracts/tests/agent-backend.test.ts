// Runs the AgentBackend conformance suite against FakeAgentBackend.
import { runAgentBackendConformance } from "../conformance/agent-backend";
import { FakeAgentBackend } from "../fakes/agent-backend";

runAgentBackendConformance((...args) => new FakeAgentBackend(...args));
