import { pluginMetadataSchema } from "@bb/domain";
import { threadPluginMetadataSeedSchema } from "@bb/server-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { pluginHookProvider } from "../plugins/plugin-hook-registry.js";
import { decideWithinBox } from "./dispatch-hooks.js";

const decisionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("accept"), metadata: pluginMetadataSchema })
    .strict(),
  z
    .object({ action: z.literal("reject"), message: z.string().min(1) })
    .strict(),
]);

export async function validateThreadMetadataSeed(input: unknown) {
  const seed = threadPluginMetadataSeedSchema.parse(input);
  const provider = pluginHookProvider();
  const registration = provider
    ?.listHooks("experimental_thread.metadataSeed")
    .find((entry) => entry.pluginId === seed.pluginId);
  const fail = (message: string): never => {
    throw new ApiError(
      400,
      "invalid_request",
      `Plugin metadata seed (${seed.pluginId}): ${message}`,
    );
  };
  if (!provider || !registration) return fail("no running seed validator");
  const result = await decideWithinBox(
    () =>
      provider.invokeHook(
        registration,
        "experimental_thread.metadataSeed",
        async () => registration.handler({ metadata: seed.metadata }),
      ),
    provider.decisionTimeoutMs,
  );
  if (!result.ok) return fail(result.error);
  if (!result.value.ok) return fail(result.value.error);
  const parsed = decisionSchema.safeParse(result.value.value);
  if (!parsed.success) return fail("invalid validator decision");
  if (parsed.data.action === "reject") return fail(parsed.data.message);
  return { pluginId: seed.pluginId, metadata: parsed.data.metadata };
}
