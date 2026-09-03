// The per-session context a facet derives from what the Workshop knows about a session (today:
// the person an agent acts for) must reach every request of that session and nowhere else.

import { afterEach, expect, it, vi } from "vitest";

import { McpClient } from "../src/client.js";
import { withClient, type ConnectionAccount } from "../src/connection.js";
import { McpFacetBase } from "../src/facet.js";
import { guardedFetch } from "../src/fetch.js";
import { McpSessionBase, type McpSessionContext, type McpSessionHost } from "../src/session.js";
import { classifyTool, type ServerTrust } from "../src/tools.js";
import type { ResourceDescription, SessionContext } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectionEnv, WithClientOptions } from "../src/connection.js";
import type { ScopedCatalog } from "../src/catalog.js";

afterEach(() => vi.unstubAllGlobals());

const ACTOR = "x-tyms-actor";

const account: ConnectionAccount = {
  async getConnection() {
    return { authorization: "assistant-key", sessionId: "session", generation: 1 };
  },
  async assertConnectionCurrent() {},
  async setMcpSessionId() { return true; },
  async noteCredentialsExpired() {},
};

function okResult(id: unknown) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] },
  }), { headers: { "Content-Type": "application/json" } });
}

it("sends the extra headers on a tool call, alongside the bearer", async () => {
  const seen: Record<string, string | null>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({ actor: headers.get(ACTOR), authorization: headers.get("Authorization") });
    return okResult(JSON.parse(String(init.body)).id);
  });

  await withClient({}, account, "https://acme.organization.tyms.ai/w/company/mcp",
    client => client.callTool("search", { q: "expenses" }),
    { headers: { [ACTOR]: "signed-assertion" } });

  expect(seen).toEqual([{ actor: "signed-assertion", authorization: "Bearer assistant-key" }]);
});

it("sends no extra header when the operation carries none", async () => {
  const seen: (string | null)[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get(ACTOR));
    return okResult(JSON.parse(String(init.body)).id);
  });

  await withClient({}, account, "https://mcp.example.com",
    client => client.callTool("search", {}));

  expect(seen).toEqual([null]);
});

it("keeps an origin-bound header on a same-origin redirect and drops it across origins", async () => {
  const hops: { url: string; actor: string | null }[] = [];
  const chain: Record<string, string> = {
    "https://mcp.example.com/mcp": "https://mcp.example.com/v2/mcp",
    "https://mcp.example.com/v2/mcp": "https://elsewhere.example.net/mcp",
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    hops.push({ url: String(input), actor: new Headers(init.headers).get(ACTOR) });
    const target = chain[String(input)];
    if (target) return new Response("", { status: 302, headers: { Location: target } });
    return new Response("ok", { status: 200 });
  });

  await guardedFetch("https://mcp.example.com/mcp",
    { headers: { [ACTOR]: "signed-assertion", Authorization: "Bearer key" } },
    { originBoundHeaders: [ACTOR] });

  expect(hops.map(hop => hop.actor)).toEqual(["signed-assertion", "signed-assertion", null]);
});

it("does not treat an extra header as origin-bound unless told so", async () => {
  // The client sets extra headers; only `withClient` knows which are credentials-like. A bare
  // client with no `originBoundHeaders` keeps them, so the default is the old behaviour.
  const hops: (string | null)[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    hops.push(new Headers(init.headers).get("x-trace"));
    if (String(input) === "https://mcp.example.com/mcp") {
      return new Response("", { status: 302, headers: { Location: "https://cdn.example.net/x" } });
    }
    return new Response("ok", { status: 200 });
  });

  await guardedFetch("https://mcp.example.com/mcp", { headers: { "x-trace": "t" } });

  expect(hops).toEqual(["t", "t"]);
});

it("forwards the session context's call options to the host on a read", async () => {
  const entry = classifyTool({ name: "search", annotations: { readOnlyHint: true } }, "vetted");
  const calls: (WithClientOptions | undefined)[] = [];
  const host = {
    serverName: "Wiki",
    endpoint: "https://acme.organization.tyms.ai/w/company/mcp",
    scope: {},
    findTool: async () => entry,
    call: async (fn: (client: McpClient) => Promise<unknown>, options?: WithClientOptions) => {
      calls.push(options);
      return fn({ callTool: async () => ({ content: [] }) } as unknown as McpClient);
    },
  } as unknown as McpSessionHost;
  const context: McpSessionContext = { callOptions: { headers: { [ACTOR]: "signed" } } };
  const withActor = new McpSessionBase(host, { authorizeObservation() {} } as never, context);
  const without = new McpSessionBase(host, { authorizeObservation() {} } as never);

  await withActor.callTool("search", {});
  await without.callTool("search", {});

  expect(calls).toEqual([{ headers: { [ACTOR]: "signed" } }, undefined]);
});

// A facet that turns the Workshop's session context into the header the wiki verifies, the way
// the Intelligence gatekeeper does; the base class must hand it to the session it constructs.
const log = { debug() {}, info() {}, error() {}, warn() {}, with() { return this; } };

class RecordingSession extends McpSessionBase {
  constructor(host: McpSessionHost, queue: never, context?: McpSessionContext) {
    super(host, queue, context);
    RecordingSession.contexts.push(context);
  }
  static contexts: (McpSessionContext | undefined)[] = [];
}

class ActorFacet extends McpFacetBase<ConnectionEnv, { endpoint: string; scope: {} },
    RecordingSession> {
  protected get log() { return log; }
  protected get trust(): ServerTrust { return "vetted"; }
  protected get sessionClass() { return RecordingSession; }
  protected get actionScopeTag() { return "test"; }
  protected get observerName() { return "the wiki"; }
  protected account(): ConnectionAccount { throw new Error("not used"); }
  describe(): Promise<ResourceDescription> { throw new Error("not used"); }
  getTypeScriptTypes(): Promise<string> { throw new Error("not used"); }
  get serverName() { return "Wiki"; }
  protected override async catalog(): Promise<ScopedCatalog> {
    return { isPortal: false, truncated: false, tools: [] };
  }
  protected override async sessionContext(
    context?: SessionContext,
  ): Promise<McpSessionContext | undefined> {
    const minted = await context?.actor?.assertion?.mint();
    return minted ? { callOptions: { headers: { [ACTOR]: minted.token } } } : undefined;
  }
}

it("derives the session context once per session from what the Workshop passed", async () => {
  const subject = new ActorFacet({
    props: { endpoint: "https://acme.organization.tyms.ai/w/company/mcp", scope: {} },
    storage: { kv: {} },
  } as never, {});
  const queue = { dup() { return this; } };
  RecordingSession.contexts = [];

  await subject.startSession(queue as never, {
    actor: { email: "ann@acme.test", assertion: {
      async mint() { return { token: "signed-for-ann", expiresAt: Date.now() + 900_000 }; },
    } as never },
  });
  await subject.startSession(queue as never, { actor: { email: "bob@acme.test" } });
  await subject.startSession(queue as never);

  expect(RecordingSession.contexts).toEqual([
    { callOptions: { headers: { [ACTOR]: "signed-for-ann" } } },
    undefined,
    undefined,
  ]);
});
