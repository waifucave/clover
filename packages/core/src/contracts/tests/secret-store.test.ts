// Runs the SecretStore conformance suite against MemorySecretStore.
import { runSecretStoreConformance } from "../conformance/secret-store";
import { MemorySecretStore } from "../fakes/secret-store";

runSecretStoreConformance((...args) => new MemorySecretStore(...args));
