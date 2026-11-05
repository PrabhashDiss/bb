import { afterEach, describe, expect, it } from "vitest";
import type { PluginHookHandler, PluginHookName } from "@get-bb/plugin-sdk";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { validateThreadMetadataSeed } from "../../src/services/threads/thread-metadata-seed.js";

function install(
  handler: PluginHookHandler<"experimental_thread.metadataSeed">,
) {
  const registry: { [K in PluginHookName]: PluginHookRegistration<K>[] } = {
    "message.dispatch": [],
    "experimental_thread.metadataSeed": [{ pluginId: "validator", handler }],
  };
  setPluginHookProvider({
    listHooks: (name) => registry[name],
    invokeHook: (_entry, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 5,
  });
}

afterEach(() => setPluginHookProvider(undefined));
const seed = { pluginId: "validator", metadata: { forged: true } };

describe("metadata seed validation", () => {
  it("rejects an unavailable namespace", async () => {
    await expect(validateThreadMetadataSeed(seed)).rejects.toThrow(
      "no running seed validator",
    );
  });
  it("replaces caller metadata with the plugin result", async () => {
    install(() => ({ action: "accept", metadata: { canonical: true } }));
    await expect(validateThreadMetadataSeed(seed)).resolves.toEqual({
      pluginId: "validator",
      metadata: { canonical: true },
    });
  });
  it("fails closed on rejection, exceptions and timeouts", async () => {
    install(() => ({ action: "reject", message: "Unknown role" }));
    await expect(validateThreadMetadataSeed(seed)).rejects.toThrow(
      "Unknown role",
    );
    install(() => {
      throw new Error("validator failed");
    });
    await expect(validateThreadMetadataSeed(seed)).rejects.toThrow(
      "validator failed",
    );
    install(() => new Promise(() => {}));
    await expect(validateThreadMetadataSeed(seed)).rejects.toThrow(
      "did not decide within 5ms",
    );
  });
  it("rejects oversized canonical metadata", async () => {
    install(() => ({
      action: "accept",
      metadata: { text: "x".repeat(300_000) },
    }));
    await expect(validateThreadMetadataSeed(seed)).rejects.toThrow(
      "invalid validator decision",
    );
  });
});
