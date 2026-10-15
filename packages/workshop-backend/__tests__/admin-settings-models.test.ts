import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AdminSettings } from "../src/admin-settings.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

type ModelStorage = {
  storage: {
    aiModels: {
      put(record: unknown): void;
      list(): Iterable<unknown>;
    };
    quickModel: { get(): string | null; put(id: string | null): void };
  };
};

describe("retired models", () => {
  it("purges the models admins added with their own keys, and the quick model", async () => {
    const stub = env.TEST_ADMIN_SETTINGS.getByName("purge-retired-models");
    await runInDurableObject(stub, async (instance: AdminSettings, state) => {
      const before = instance as unknown as ModelStorage;
      before.storage.aiModels.put({
        profile: { type: "agent", id: "byok-model", name: "Own key" },
        config: { provider: "openai", model: "gpt", apiKey: "sk-secret" },
      });
      before.storage.quickModel.put("byok-model");

      // A fresh instance on the same storage is what the next start of the object sees.
      const after = new AdminSettings(state, env) as unknown as ModelStorage;
      expect([...after.storage.aiModels.list()]).toEqual([]);
      expect(after.storage.quickModel.get()).toBeNull();
    });
  });
});
