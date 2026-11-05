// The inherited protocol: JSON-RPC 2.0 over NDJSON, `SessionEvent` and its methods. C1 retires it method by method.
export * from "./jsonrpc";
export * from "./events";
export * from "./methods";
export * from "./ndjson";
export * from "./conn-writer";
export * from "./cowork";

// Clover's protocol (spec revision 17): the shared vocabulary, the roles, one file per area, and the index that
// gathers them. Names here never repeat one of the inherited exports above.
export * from "./common";
export * from "./roles";
export * from "./rpc";
export * from "./plugins";
export * from "./approvals";
export * from "./sessions";
export * from "./devices";
export * from "./computers";
export * from "./agents";
export * from "./app";
export * from "./browser";
export * from "./usage";
export * from "./clover";
