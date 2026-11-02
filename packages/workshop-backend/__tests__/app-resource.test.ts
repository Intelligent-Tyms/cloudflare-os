// The person's workspace for a first-party app (PublicApi.openEmbedded) has the app itself in every
// chat: its connection is marked `app` (Overseer.ensureAppResource) and taken in like an ambient
// resource, so the assistant there can use the app with nothing to connect.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`app-resource-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = "owner-user-do";
    impl.storage.title.put("Tasks");
    impl.getGatekeeperFacet = async (id: number) => ({
      describe: async () => ({
        title: id === 1 ? "Tasks" : "Other", url: "https://example.com",
        suggestedBindingName: id === 1 ? "MCP_TASKS" : "OTHER",
      }),
      getAgentCatalog: async () => null,
    });
    for (let id of [1, 2]) {
      impl.storage.chatMeta.put({ id, title: "Chat", started: new Date(0), lastActive: new Date(id) });
    }
    await fn(impl);
  });
}

describe("the app's connection in its workspace", () => {
  it("is in every new chat, while an ordinary unbound connection is not", () => withImpl(async impl => {
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Tasks", class: {} as any, app: "tasks",
      creationSpec: { type: "gatekeeper", vendorId: "mcp", resourceUrl: "https://tasks.example/mcp" } });
    impl.storage.gatekeepers.put({ id: 2, resourceTitle: "Other", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "mcp", resourceUrl: "https://other.example/mcp" } });

    await impl.prepareChatBindings(1, []);
    expect(impl.getChatAgentContext(1).bindings).toEqual({ MCP_TASKS: 1 });
    expect(impl.findAppGatekeeper("tasks")?.id).toBe(1);
    expect(impl.findAppGatekeeper("crm")).toBeUndefined();
  }));

  it("reaches a chat that started before the app was added", () => withImpl(async impl => {
    await impl.prepareChatBindings(1, []);
    expect(impl.getChatAgentContext(1).bindings).toEqual({});

    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Tasks", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "mcp", resourceUrl: "https://tasks.example/mcp" } });
    impl.markAppGatekeeper(1, "tasks");
    await impl.prepareChatBindings(1, []);
    expect(impl.getChatAgentContext(1).bindings).toEqual({ MCP_TASKS: 1 });
  }));
});
