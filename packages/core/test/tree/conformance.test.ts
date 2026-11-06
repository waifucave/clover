// Lane B's Tree conformance suite, against the real tree: each computer's files on its own temp folder, each call run
// by the holder of its files (see harness.ts).
import { runTreeConformance } from "../../src/contracts/conformance/tree";
import { realTreeHarness } from "./harness";

// The holder's reviewer (R1) and R15's one answer between computers are J-M2's (#177); until then they run as todo.
runTreeConformance((opts) => realTreeHarness(opts), { pending: ["r1", "r15"] });
