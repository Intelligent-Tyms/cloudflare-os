import { describe, expect, it } from "vitest";

import {
  FAILURE_BACKOFF_MS,
  MAX_CHANGE_CHARS,
  backoffKey,
  forgetHook,
  opsResourceUri,
  pollHooks,
  registrationKey,
  type OpsChangeRaw,
  type OpsWatchRegistration,
  type WatchKv,
} from "../src/ops-watch.js";

/** A Map with the slice of Durable Object KV the poll uses. */
function memoryKv(): WatchKv & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T,>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => void map.set(key, value),
    delete: key => map.delete(key),
    *list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
      for (const [key, value] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
        if (key.startsWith(prefix)) yield [key, value as T];
      }
    },
  };
}

const GRACE: OpsWatchRegistration = {
  watch: ["alerts", "attention"],
  tenant: "acme",
  app: "operations",
  endpoint: "https://acme.ops.tyms.ai/mcp",
  actor: "grace@acme.example",
};

function harness() {
  const kv = memoryKv();
  const resources = new Map<string, string>([["ops://acme/alerts", "{\"recent\":[]}"], ["ops://acme/attention", "{\"review\":[]}"]]);
  const reads: string[] = [];
  const queued: { hookKey: string; messageId: string; change: OpsChangeRaw }[] = [];
  const errors: unknown[] = [];
  let failing = false;
  const poll = (now: number) => pollHooks({
    kv,
    now,
    read: async (registration, uri) => {
      reads.push(`${registration.actor} ${uri}`);
      if (failing) throw new Error("not a member of this workspace");
      return resources.get(uri) ?? "";
    },
    enqueue: (hookKey, messageId, change) => void queued.push({ hookKey, messageId, change }),
    onError: error => void errors.push(error),
  });
  return { kv, resources, reads, queued, errors, poll, fail: (on: boolean) => (failing = on) };
}

describe("ops change hooks: polling", () => {
  it("names the tenant's resources from the app endpoint", () => {
    expect(opsResourceUri("https://Acme.ops.tyms.ai/mcp", "alerts")).toBe("ops://acme/alerts");
    expect(opsResourceUri(GRACE.endpoint, "attention")).toBe("ops://acme/attention");
  });

  it("records where each resource stands first, then queues only what changed", async () => {
    const h = harness();
    h.kv.put(registrationKey("h1"), GRACE);

    await h.poll(1_000);
    expect(h.queued).toEqual([]);
    expect(h.reads).toEqual(["grace@acme.example ops://acme/alerts", "grace@acme.example ops://acme/attention"]);

    await h.poll(61_000);
    expect(h.queued).toEqual([]);

    h.resources.set("ops://acme/alerts", "{\"recent\":[{\"trigger_key\":\"payment_failed\"}]}");
    await h.poll(121_000);
    expect(h.queued).toEqual([{
      hookKey: "h1",
      messageId: "alerts:121000",
      change: { watch: "alerts", uri: "ops://acme/alerts", text: "{\"recent\":[{\"trigger_key\":\"payment_failed\"}]}", at: 121_000 },
    }]);
  });

  it("reads a resource once per person per round, however many hooks watch it", async () => {
    const h = harness();
    h.kv.put(registrationKey("h1"), GRACE);
    h.kv.put(registrationKey("h2"), { ...GRACE, watch: ["alerts"] });
    h.kv.put(registrationKey("h3"), { ...GRACE, actor: "sam@acme.example", watch: ["alerts"] });
    await h.poll(1_000);
    expect(h.reads.sort()).toEqual([
      "grace@acme.example ops://acme/alerts",
      "grace@acme.example ops://acme/attention",
      "sam@acme.example ops://acme/alerts",
    ]);

    h.resources.set("ops://acme/alerts", "{\"recent\":[1]}");
    await h.poll(61_000);
    expect(h.queued.map(q => q.hookKey).sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("backs a hook off when its reads fail, and resumes after", async () => {
    const h = harness();
    h.kv.put(registrationKey("h1"), GRACE);
    h.fail(true);
    await h.poll(1_000);
    expect(h.errors).toHaveLength(1);
    expect(h.kv.get(backoffKey("h1"))).toBe(1_000 + FAILURE_BACKOFF_MS);

    h.fail(false);
    const before = h.reads.length;
    await h.poll(61_000);
    expect(h.reads.length).toBe(before); // still backing off

    await h.poll(1_000 + FAILURE_BACKOFF_MS + 1);
    expect(h.reads.length).toBeGreaterThan(before);
    expect(h.kv.get(backoffKey("h1"))).toBeUndefined();
  });

  it("caps what a change carries", async () => {
    const h = harness();
    h.kv.put(registrationKey("h1"), { ...GRACE, watch: ["alerts"] });
    await h.poll(1_000);
    h.resources.set("ops://acme/alerts", "x".repeat(MAX_CHANGE_CHARS + 500));
    await h.poll(61_000);
    expect(h.queued[0]!.change.text).toHaveLength(MAX_CHANGE_CHARS);
  });

  it("forgets everything about an unregistered hook", async () => {
    const h = harness();
    h.kv.put(registrationKey("h1"), GRACE);
    await h.poll(1_000);
    expect([...h.kv.map.keys()].some(k => k.includes("h1"))).toBe(true);
    forgetHook(h.kv, "h1");
    expect([...h.kv.map.keys()].some(k => k.includes("h1"))).toBe(false);
  });
});
