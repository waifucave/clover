// Lane B's Tree conformance suite, against the real tree: each computer's files on its own temp folder, each call run
// by the holder of its files (see harness.ts).
import { runTreeConformance } from "../../src/contracts/conformance/tree";
import { realTreeHarness } from "./harness";

runTreeConformance((opts) => realTreeHarness(opts));
