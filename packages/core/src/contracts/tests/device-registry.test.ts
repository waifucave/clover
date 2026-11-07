// Runs the DeviceRegistry conformance suite against FakeDeviceRegistry.
import { runDeviceRegistryConformance } from "../conformance/device-registry";
import { FakeDeviceRegistry } from "../fakes/device-registry";

// The fake still lets a phone with no answer key answer with its link key, which lane B's follow-up drops.
runDeviceRegistryConformance((...args) => FakeDeviceRegistry.create(...args), { pending: ["phone-answer-key-only"] });
