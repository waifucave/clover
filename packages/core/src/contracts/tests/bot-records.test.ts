// Runs the BotRecords conformance suite against FakeBotRecords.
import { runBotRecordsConformance } from "../conformance/bot-records";
import { FakeBotRecords } from "../fakes/bot-records";

runBotRecordsConformance((...args) => new FakeBotRecords(...args));
