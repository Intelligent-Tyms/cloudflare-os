// Billing tasks on AI usage events (src/ai-task.ts): every usage event of an agent turn carries the
// turn's task id, concurrent turns never share one, housekeeping calls carry none, and each app
// model-binding call is a task of its own. Drives real turns on a real OverseerDurableObject with
// the model provider's HTTP API stubbed (as agent-tracing.test.ts does), and captures what the
// overseer hands the usage collector.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UsageEventReport } from "../src/billing-directory.js";
import { LanguageModelGatekeeper } from "../src/ai-models.js";
import { currentAgentTurnTask, runInAgentTurnTask } from "../src/ai-task.js";

interface OverseerInternals {
  ownerId: string;
  users: object;
  storage: {
    chatMeta: { put(meta: AiChatMetadata): void, get(chatId: number): AiChatMetadata | undefined };
    chats: { put(message: AiChatMessage): void };
  };
  nextChatSequence(chatId: number): number;
  recordAiUsage(events: UsageEventReport[]): void;
  startAgent(chatId: number, aiModel: AiModel, initiator: AiChatAuthorInfo,
             initiatorUserId: string): void;
  waitForAllAgentsToComplete(): Promise<void>;
  generateThreadTitle(chatId: number, initialMessage: string, config: AiModelConfig,
                      initiator: AiChatAuthorInfo): Promise<void>;
  generateBindingName(subject: string, takenNames: Set<string>,
                      quick: { config: AiModelConfig, initiator: AiChatAuthorInfo })
      : Promise<string | undefined>;
}

interface AiModel {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const MODEL: AiChatAuthorInfo = { type: "agent", id: "claude", name: "Claude" };
const API_URL = "https://anthropic.test";
// A catalog model, so pi prices each response and every step reports a cost.
const CONFIG: AiModelConfig = {
  provider: "anthropic", model: "claude-opus-5-5", apiToken: "test-key", apiUrl: API_URL,
};
// Turns on usage metering (hasBillingDirectory) for the model-binding gatekeeper; its collector is
// faked below.
const BILLING_ENV = {
  CENTRAL_TEAM_API_URL: "https://billing.test", CENTRAL_TEAM_API_TOKEN: "billing-token",
};

type ContentBlock =
  | { type: "text", text: string }
  | { type: "tool_use", id: string, name: string, input: object };

// A streamed Anthropic Messages response.
function anthropicResponse(blocks: ContentBlock[], stopReason: string): Response {
  let events: Record<string, unknown>[] = [
    { type: "message_start", message: {
      id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model: CONFIG.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
               output_tokens: 1 },
    } },
    ...blocks.flatMap((block, index) => [
      block.type === "text"
        ? { type: "content_block_start", index, content_block: { type: "text", text: "" } }
        : { type: "content_block_start", index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
      block.type === "text"
        ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }
        : { type: "content_block_delta", index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  let body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
}

// Stubs the provider. A turn's first request is answered with a tool call and the request after
// the tool's result with a final reply -- two model steps per turn. The first `holdFirst`
// requests are held until that many have arrived, so that many turns are provably in flight at
// once.
function stubProvider(holdFirst = 0): { requests: () => number } {
  let calls = 0;
  let release!: () => void;
  let barrier = new Promise<void>(resolve => { release = resolve; });
  let realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    let request = new Request(input as RequestInfo, init);
    // Billing-directory calls fail fast, as an unreachable directory does (everything fails open).
    if (new URL(request.url).origin === BILLING_ENV.CENTRAL_TEAM_API_URL) {
      return new Response("{}", { status: 503 });
    }
    if (new URL(request.url).origin !== API_URL) return realFetch(input, init);
    let call = ++calls;
    let body = await request.json() as { messages: { content: unknown }[] };
    if (call <= holdFirst) {
      if (call === holdFirst) release();
      await barrier;
    }
    let last = JSON.stringify(body.messages.at(-1)?.content ?? "");
    if (last.includes("tool_result")) {
      return anthropicResponse([{ type: "text", text: "Done." }], "end_turn");
    }
    if (body.messages.length === 1 && last.includes("Title please")) {
      return anthropicResponse([{ type: "text", text: "A Title" }], "end_turn");
    }
    if (last.includes("binding name")) {
      return anthropicResponse([{ type: "text", text: "QUARTERLY_PLAN" }], "end_turn");
    }
    return anthropicResponse([{ type: "tool_use", id: `toolu_${call}`, name: "readFile",
                                input: { workpiece: "NOPE", filename: "missing.txt" } }],
                             "tool_use");
  });
  return { requests: () => calls };
}

// A `ctx.exports` whose usage collector records into `events`.
function capturingExports(events: UsageEventReport[]): object {
  let collector = {
    record: async (batch: UsageEventReport[]) => { events.push(...batch); },
    getBillingState: async () => null,
  };
  return { UsageCollectorDurableObject: { getByName: () => collector } };
}

// Runs `fn` in a fresh workspace whose usage events land in the returned array.
async function inWorkspace(
    fn: (impl: OverseerInternals, gadgetId: string) => Promise<void>)
    : Promise<UsageEventReport[]> {
  let events: UsageEventReport[] = [];
  let stub = env.TEST_OVERSEER.getByName(`ai-task-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: OverseerInternals }).impl;
    // Every AI metering point of the overseer reports through recordAiUsage.
    impl.recordAiUsage = batch => { events.push(...batch); };
    impl.ownerId = OWNER_USER_ID;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        getChatContext: async () => ({ profile: OWNER, aiModel: { profile: MODEL, config: CONFIG } }),
        getCloudflareGatekeeperAccount: async () => null,
        consumeDailyLlmCall: async () => ({ withinLimits: true }),
        publishNotification: async () => {},
      }),
    };
    await fn(impl, stub.id.toString());
  });
  return events;
}

// Seeds `chatId` with a user message (creating the chat if needed) and starts a turn answering it.
function askInChat(impl: OverseerInternals, chatId: number, message: string): number {
  let meta = impl.storage.chatMeta.get(chatId) ?? {
    id: chatId, title: "Chat", started: new Date(0), lastActive: new Date(0),
  };
  impl.storage.chatMeta.put({ ...meta, activeAgent: MODEL });
  let sequence = impl.nextChatSequence(chatId);
  impl.storage.chats.put({
    chatId, sequence, timestamp: new Date(0), author: OWNER, type: "message", message,
  });
  impl.startAgent(chatId, { profile: MODEL, config: CONFIG }, OWNER, OWNER_USER_ID);
  return sequence;
}

// Starts another turn in `chatId` without a new prompt, as retryAgent does.
function retryInChat(impl: OverseerInternals, chatId: number): void {
  impl.storage.chats.put({
    chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(0), author: OWNER,
    type: "agentNudge", text: "Retry the previous request.",
  });
  impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(chatId)!, activeAgent: MODEL });
  impl.startAgent(chatId, { profile: MODEL, config: CONFIG }, OWNER, OWNER_USER_ID);
}

function aiEvents(events: UsageEventReport[], chatId?: number): UsageEventReport[] {
  return events.filter(event => event.kind === "ai" &&
      (chatId === undefined || event.meta?.chatId === chatId));
}

describe("AI usage task ids", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tags every model step of a chat turn with the turn's one task id", async () => {
    stubProvider();
    let promptSequence!: number;
    let gadgetId!: string;
    let events = await inWorkspace(async (impl, id) => {
      gadgetId = id;
      promptSequence = askInChat(impl, 1, "Read the file please.");
      await impl.waitForAllAgentsToComplete();
    });

    let turnEvents = aiEvents(events, 1);
    expect(turnEvents).toHaveLength(2);
    for (let event of turnEvents) {
      expect(event.meta).toMatchObject({
        gadgetId, chatId: 1, taskKind: "chat",
        taskId: `turn:${gadgetId}:1:${promptSequence}`,
      });
      expect(event.costMicroUsd).toBeGreaterThan(0);
    }
    // Each event is still its own idempotent report.
    expect(new Set(turnEvents.map(event => event.sourceKey)).size).toBe(2);
  });

  it("keeps a retried turn on its task, and starts a new one for a new prompt", async () => {
    stubProvider();
    let events = await inWorkspace(async impl => {
      askInChat(impl, 1, "First question.");
      await impl.waitForAllAgentsToComplete();
      retryInChat(impl, 1);
      await impl.waitForAllAgentsToComplete();
      askInChat(impl, 1, "Second question.");
      await impl.waitForAllAgentsToComplete();
    });

    let taskIds = aiEvents(events, 1).map(event => event.meta?.taskId);
    expect(taskIds).toHaveLength(6);
    // The first turn and its retry share a task; the new prompt's turn has its own.
    expect(new Set(taskIds.slice(0, 4)).size).toBe(1);
    expect(new Set(taskIds.slice(4)).size).toBe(1);
    expect(taskIds[4]).not.toBe(taskIds[0]);
  });

  it("gives concurrent turns in one workspace distinct task ids, never crossed", async () => {
    // Both turns' first requests are held until both have been sent: the turns overlap.
    let provider = stubProvider(2);
    let sequences: Record<number, number> = {};
    let gadgetId!: string;
    let events = await inWorkspace(async (impl, id) => {
      gadgetId = id;
      sequences[1] = askInChat(impl, 1, "Question one.");
      sequences[2] = askInChat(impl, 2, "Question two.");
      await impl.waitForAllAgentsToComplete();
    });
    expect(provider.requests()).toBe(4);

    for (let chatId of [1, 2]) {
      let chatEvents = aiEvents(events, chatId);
      expect(chatEvents).toHaveLength(2);
      for (let event of chatEvents) {
        expect(event.meta?.taskId).toBe(`turn:${gadgetId}:${chatId}:${sequences[chatId]}`);
      }
    }
    expect(aiEvents(events, 1)[0].meta?.taskId).not.toBe(aiEvents(events, 2)[0].meta?.taskId);
  });

  it("marks housekeeping calls as housekeeping, with no task id", async () => {
    stubProvider();
    let events = await inWorkspace(async impl => {
      impl.storage.chatMeta.put({
        id: 1, title: "New Chat", started: new Date(0), lastActive: new Date(0),
      });
      // Even from inside a turn's context, a housekeeping call bills no task.
      await runInAgentTurnTask({ taskId: "turn:x:1:0", taskKind: "chat", chatId: 1 }, async () => {
        await impl.generateThreadTitle(1, "Title please", CONFIG, OWNER);
        await impl.generateBindingName("a document for the binding name test", new Set(),
                                       { config: CONFIG, initiator: OWNER });
      });
    });

    let housekeeping = aiEvents(events);
    expect(housekeeping.map(event => event.meta?.source).sort())
        .toEqual(["binding-name", "thread-title"]);
    for (let event of housekeeping) {
      expect(event.meta?.taskKind).toBe("housekeeping");
      expect(event.meta).not.toHaveProperty("taskId");
    }
  });

  it("makes each model-binding call a task of its own", async () => {
    stubProvider();
    let events: UsageEventReport[] = [];
    let waits: Promise<unknown>[] = [];
    let gatekeeper = Object.create(LanguageModelGatekeeper.prototype) as LanguageModelGatekeeper;
    Object.assign(gatekeeper, {
      env: { ...BILLING_ENV } as unknown as Cloudflare.Env,
      ctx: {
        props: {
          displayName: "Model", config: CONFIG,
          initiator: { type: "gadget", id: "app", name: "App" },
          metadata: { source: "model-binding", gadgetId: "gadget-1" },
        },
        exports: capturingExports(events),
        waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
      },
    });
    let binding = await gatekeeper.startSession(undefined as never);
    await binding.run({ prompt: "binding name one" });
    await binding.run({ prompt: "binding name two" });
    await Promise.all(waits);

    expect(events).toHaveLength(2);
    for (let event of events) {
      expect(event.meta).toMatchObject({
        source: "model-binding", gadgetId: "gadget-1", taskKind: "app",
      });
      expect(event.meta?.taskId).toMatch(/^app:/);
    }
    expect(events[0].meta?.taskId).not.toBe(events[1].meta?.taskId);
  });

  it("scopes the turn task to its own async context", async () => {
    let seen: (string | undefined)[] = [];
    let turn = (taskId: string) => runInAgentTurnTask(
        { taskId, taskKind: "chat", chatId: 1 }, async () => {
          for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 1));
            seen.push(`${taskId}=${currentAgentTurnTask()?.taskId}`);
          }
        });
    await Promise.all([turn("a"), turn("b")]);
    expect(seen.sort()).toEqual(["a=a", "a=a", "a=a", "b=b", "b=b", "b=b"]);
    expect(currentAgentTurnTask()).toBeUndefined();
  });
});
