// Lane B's AgentBackend conformance suite, run against lane K's real ACP client and a scripted agent process.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentBackendConformance } from "../../contracts/conformance/agent-backend";
import { acpConformanceFactory } from "../testing/harness";

const root = mkdtempSync(join(tmpdir(), "clover-k-conf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

runAgentBackendConformance(acpConformanceFactory(root));
