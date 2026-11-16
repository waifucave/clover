// Runs the ProgramAnswerKeys conformance suite against FakeProgramAnswerKeys.
import { runProgramAnswerKeysConformance } from "../conformance/program-keys";
import { FakeProgramAnswerKeys } from "../fakes/program-keys";

runProgramAnswerKeysConformance(() => new FakeProgramAnswerKeys());
