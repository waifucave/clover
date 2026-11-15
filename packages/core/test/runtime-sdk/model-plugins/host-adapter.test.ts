// What the user reads when a code model plugin itself fails a call (`pluginFailure`): crashed mid-reply, stopped, or
// unable to start, each in words that say what to do; a provider's own error and the session's cancel pass through.
// The real-host deaths (a killed worker host, a stopped plugin, a killed own process) are code-adapters-host.test.ts's.
import { expect, test } from "bun:test";
import { ProviderRequestError } from "@waifucave/clover-provider-runtime";
import { ContractError } from "../../../src/contracts/common";
import { pluginFailure } from "../../../src/runtime-sdk/model-plugins/host-adapter";

const words = (err: unknown) => (err as Error).message;

test("crashed, stopped or unable to start: a provider error in words, not retried by itself", () => {
  const crashed = pluginFailure(new ContractError("failed", "the plugin crashed: the plugin host exited"), "Acme");
  expect(crashed).toBeInstanceOf(ProviderRequestError);
  expect(words(crashed)).toBe("The Acme model plugin stopped during this reply (the plugin host exited). Clover starts it again: send again to retry.");
  expect((crashed as ProviderRequestError).retryable).toBe(false);
  expect(words(pluginFailure(new ContractError("plugin_stopped", "plugin stopped: crashed 3 times in 5 minutes"), "Acme"))).toBe("The Acme model plugin is stopped (crashed 3 times in 5 minutes), so this reply couldn't run. Turn it on in Settings → Plugins, then send again.");
  expect(words(pluginFailure(new ContractError("failed", "plugin processes can't start here: no Bun"), "Acme"))).toBe("The Acme model plugin couldn't run this reply (plugin processes can't start here: no Bun). Send again to retry, or check it in Settings → Plugins.");
  expect(words(pluginFailure(new ContractError("refused", "acme isn't the bundled code Clover verified"), "Acme"))).toStartWith("The Acme model plugin couldn't run this reply");
});

test("the session's own cancel and a provider's own error pass through as they are", () => {
  const cancel = new ContractError("cancelled", "the session ended");
  expect(pluginFailure(cancel, "Acme")).toBe(cancel);
  const limited = new ProviderRequestError({ code: "rate_limit", retryable: true, message: "slow down" });
  expect(pluginFailure(limited, "Acme")).toBe(limited);
  const plain = new Error("boom");
  expect(pluginFailure(plain, "Acme")).toBe(plain);
});
