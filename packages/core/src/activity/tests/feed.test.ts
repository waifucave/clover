// Runs the ActivityFeed conformance suite against the engine's feed.
import { runActivityFeedConformance } from "../../contracts/conformance/activity-feed";
import { EngineActivityFeed } from "../feed";

runActivityFeedConformance(() => new EngineActivityFeed());
