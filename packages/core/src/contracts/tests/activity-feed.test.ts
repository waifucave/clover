// Runs the ActivityFeed conformance suite against FakeActivityFeed.
import { runActivityFeedConformance } from "../conformance/activity-feed";
import { FakeActivityFeed } from "../fakes/activity-feed";

runActivityFeedConformance(() => new FakeActivityFeed());
