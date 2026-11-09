// The real plugin host (daemon side and host side, joined in one process) against the PluginHost conformance suite.
import { runPluginHostConformance } from "../../contracts/conformance/plugin-host";
import { LoopbackPluginHost } from "../loopback";

runPluginHostConformance((opts) => new LoopbackPluginHost(opts));
