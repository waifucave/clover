// Runs the DeviceRegistry conformance suite against FakeDeviceRegistry.
import { runDeviceRegistryConformance } from "../conformance/device-registry";
import { FakeDeviceRegistry } from "../fakes/device-registry";

runDeviceRegistryConformance((...args) => FakeDeviceRegistry.create(...args));
