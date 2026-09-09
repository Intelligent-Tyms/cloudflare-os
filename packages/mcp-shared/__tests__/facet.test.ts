import { expect, it, vi } from "vitest";

import { McpFacetBase } from "../src/facet.js";
import { McpSessionBase } from "../src/session.js";
import { classifyTool, type ServerTrust } from "../src/tools.js";
import type { McpClient, McpTool, McpToolCallResult } from "../src/client.js";
import type { ToolScope } from "../src/scope.js";
import type { ScopedCatalog } from "../src/catalog.js";
import type { ConnectionAccount } from "../src/connection.js";
import type { LoggedRead } from "../src/observer-store.js";
import type { McpSharingPolicy } from "../src/sharing-policy.js";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { fakeSql } from "./stubs/sql.js";

const log = {
  debug() {}, info() {}, error() {},
  warnings: [] as string[],
  warn(message: string) { this.warnings.push(message); },
  with() { return this; },
};

class TestSession extends McpSessionBase {}

class TestFacet extends McpFacetBase<object, {
  endpoint: string;
  scope: ToolScope;
}, TestSession> {
  catalogResult: Promise<ScopedCatalog> = Promise.resolve({
    isPortal: false,
    truncated: false,
    tools: [
      classifyTool({ name: "list_issues", annotations: { readOnlyHint: true } } as never, "byo"),
    ],
  });
  catalogReads = 0;
  remoteTools: McpTool[] = [];
  remoteCalls = 0;
  beforeCatalogRead: (() => Promise<void>) | undefined;
  sharingPolicy: McpSharingPolicy = "owner-only";
  replayed: Array<{ account: string; toolName: string; args: Record<string, unknown> }> = [];
  replayOutcome: (read: LoggedRead) => McpToolCallResult | Error = () => ({ content: [] });

  protected get log() { return log; }
  protected get trust(): ServerTrust { return "byo"; }
  protected get sharing(): McpSharingPolicy { return this.sharingPolicy; }
  protected accountById(id: string): ConnectionAccount {
    return { id } as unknown as ConnectionAccount;
  }
  protected override async replayRead(
    account: ConnectionAccount, read: LoggedRead,
  ): Promise<McpToolCallResult> {
    this.replayed.push({
      account: (account as unknown as { id: string }).id, toolName: read.toolName, args: read.args,
    });
    const outcome = this.replayOutcome(read);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
  protected get sessionClass() { return TestSession; }
  protected get actionScopeTag() { return "test"; }
  protected get observerName() { return "the test server"; }
  protected account(): ConnectionAccount { throw new Error("not used"); }
  describe(): Promise<ResourceDescription> { throw new Error("not used"); }
  getTypeScriptTypes(): Promise<string> { throw new Error("not used"); }
  get serverName() { return "Test"; }
  protected override async catalog() {
    this.catalogReads++;
    await this.beforeCatalogRead?.();
    return this.catalogResult;
  }
  override async call<T>(
    fn: (client: McpClient) => Promise<T>,
  ): Promise<T> {
    this.remoteCalls++;
    const client = {
      findTool: async (name: string) => this.remoteTools.find(tool => tool.name === name),
      listTools: async (
        _maxTools: number,
        include: (tool: McpTool) => boolean,
      ) => ({ tools: this.remoteTools.filter(include), truncated: false }),
      listMatchingToolSummaries: async (
        maxTools: number,
        include: (tool: McpTool) => boolean,
      ) => this.remoteTools.filter(include).slice(0, maxTools),
    } as unknown as McpClient;
    return fn(client);
  }
  runDiscoveryTest<T>(operation: () => Promise<T>): Promise<T> {
    return this.runDiscovery(operation);
  }
}

function facet(scope: ToolScope = {}) {
  const ctx = {
    props: { endpoint: "https://example.com/mcp", scope },
    storage: { kv: {}, sql: fakeSql() },
  };
  return new TestFacet(ctx as never, {});
}

// What an observer's own connected account reports through its verifier.
function verifier(accountObjectId: string, endpoint = "https://example.com/mcp") {
  return { observerAccount: async () => ({ accountObjectId, endpoint }) } as never;
}

const queue = {
  dup() { return this; },
  authorizeObservation() {},
};

it("builds tool methods and falls back to the plain session when catalog loading fails", async () => {
  const subject = facet();
  const dynamic = await subject.startSession(queue as never);
  expect("listIssues" in dynamic).toBe(true);

  subject.catalogResult = Promise.reject(new Error("offline"));
  const fallback = await subject.startSession(queue as never);
  expect("listIssues" in fallback).toBe(false);
  expect(log.warnings).toContain("starting session without per-tool methods");
});

it("keeps facets owner-only using the connector's resource label", async () => {
  await expect(facet().addObserver("observer", {} as never))
    .rejects.toThrow(/test server.*only be opened by its owner/s);
});

it("admits anyone to a public endpoint without consulting their account", async () => {
  const subject = facet();
  subject.sharingPolicy = "public";
  await subject.recordRead("get_rates", { pair: "USDUGX" });

  await expect(subject.addObserver("observer", {} as never)).resolves.toBeUndefined();
  expect(subject.replayed).toEqual([]);
  await expect(subject.recordRead("get_rates", { pair: "EURUGX" })).resolves.toBeUndefined();
});

it("refuses a same-account observer whose account is connected elsewhere", async () => {
  const subject = facet();
  subject.sharingPolicy = "same-account";
  await expect(subject.addObserver("observer", verifier("acc", "https://other.example/mcp")))
    .rejects.toThrow(/reads from the test server.*connected to other\.example/s);
  expect(subject.replayed).toEqual([]);
});

it("admits a same-account observer once their account has repeated every read", async () => {
  const subject = facet();
  subject.sharingPolicy = "same-account";
  await subject.recordRead("get_account", { id: "a1" });
  await subject.recordRead("list_transactions", { account: "a1", limit: 10 });
  await subject.recordRead("get_account", { id: "a1" });  // a repeat: logged once

  await expect(subject.addObserver("observer", verifier("acc-obs"))).resolves.toBeUndefined();
  expect(subject.replayed).toEqual([
    { account: "acc-obs", toolName: "get_account", args: { id: "a1" } },
    { account: "acc-obs", toolName: "list_transactions", args: { account: "a1", limit: 10 } },
  ]);

  // Re-verification on the next open has nothing new to replay while the last pass is fresh.
  subject.replayed = [];
  await expect(subject.addObserver("observer", verifier("acc-obs"))).resolves.toBeUndefined();
  expect(subject.replayed).toEqual([]);

  // A later read is replayed on the observer's account before its result is handed over.
  await expect(subject.recordRead("get_account", { id: "a2" })).resolves.toBeUndefined();
  expect(subject.replayed).toEqual([
    { account: "acc-obs", toolName: "get_account", args: { id: "a2" } },
  ]);

  // And a repeat of something already verified costs nothing.
  subject.replayed = [];
  await expect(subject.recordRead("get_account", { id: "a2" })).resolves.toBeUndefined();
  expect(subject.replayed).toEqual([]);
});

it("refuses a same-account observer whose account cannot repeat a read, naming the tool", async () => {
  const subject = facet();
  subject.sharingPolicy = "same-account";
  await subject.recordRead("get_account", { id: "a1" });
  await subject.recordRead("get_account", { id: "a2" });
  subject.replayOutcome = read => read.args.id === "a2"
    ? { content: [{ type: "text", text: "Account a2 is not visible to this user" }], isError: true }
    : { content: [] };

  await expect(subject.addObserver("observer", verifier("acc-obs")))
    .rejects.toThrow(/calling "get_account" failed \(Account a2 is not visible/);

  // A transport-level refusal reads the same way to the person turned away.
  subject.replayOutcome = () => new Error("HTTP 403 from the server");
  await expect(subject.addObserver("observer", verifier("acc-obs")))
    .rejects.toThrow(/calling "get_account" failed \(HTTP 403/);
});

it("excludes an admitted observer from a read their account cannot repeat", async () => {
  const subject = facet();
  subject.sharingPolicy = "same-account";
  await expect(subject.addObserver("observer", verifier("acc-obs"))).resolves.toBeUndefined();

  subject.replayOutcome = () => ({ content: [], isError: true });
  await expect(subject.recordRead("get_account", { id: "private" })).resolves.toEqual(["observer"]);

  // Still excluded from the same read next time: nothing was verified.
  subject.replayed = [];
  await expect(subject.recordRead("get_account", { id: "private" })).resolves.toEqual(["observer"]);
  expect(subject.replayed).toHaveLength(1);

  // Once removed, nobody is excluded and nothing is replayed.
  await subject.removeObserver("observer");
  subject.replayed = [];
  await expect(subject.recordRead("get_account", { id: "private" })).resolves.toBeUndefined();
  expect(subject.replayed).toEqual([]);
});

it("excludes every observer once the policy no longer admits them or the log has overflowed", async () => {
  const subject = facet();
  subject.sharingPolicy = "same-account";
  await subject.addObserver("observer", verifier("acc-obs"));

  // The catalog moved this endpoint back to owner-only: whoever is still on the roster is
  // excluded now and refused at their next open.
  subject.sharingPolicy = "owner-only";
  await expect(subject.recordRead("get_account", { id: "a1" })).resolves.toEqual(["observer"]);
  await expect(subject.addObserver("observer", verifier("acc-obs"))).rejects.toThrow(/owner/);
  await expect(subject.recordRead("get_account", { id: "a1" })).resolves.toBeUndefined();

  // Past the log's bound nobody new can be verified, and existing observers are excluded.
  subject.sharingPolicy = "same-account";
  await subject.addObserver("observer", verifier("acc-obs"));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(subject.recordRead("get_account", cyclic)).resolves.toEqual(["observer"]);
  await expect(subject.addObserver("another", verifier("acc-2")))
    .rejects.toThrow(/too many different things/);
  expect(log.warnings.some(w => /read log overflowed/.test(w))).toBe(true);
});

it("discovers and resolves tools beyond the initially described catalog", async () => {
  const subject = facet();
  subject.catalogResult = Promise.resolve({ tools: [], isPortal: false, truncated: true });
  subject.remoteTools = [
    { name: "search_issues", description: "Search issues", annotations: { readOnlyHint: true } },
    { name: "create_issue", description: "Create an issue" },
  ];

  await expect(subject.searchTools("search")).resolves.toMatchObject([{
    tool: { name: "search_issues" }, mode: "read",
  }]);
  await expect(subject.findTool("create_issue")).resolves.toMatchObject({
    tool: { name: "create_issue" }, mode: "action",
  });
});

it("answers searches from a complete catalog without rescanning the endpoint", async () => {
  const subject = facet();
  subject.remoteTools = [{ name: "search_issues", description: "Remote copy" }];

  await expect(subject.searchTools("issues")).resolves.toMatchObject([{
    tool: { name: "list_issues" }, mode: "read",
  }]);
  expect(subject.remoteCalls).toBe(0);
});

it("does not hydrate a new portal-native tool past a complete non-portal catalog", async () => {
  const subject = facet();
  subject.remoteTools = [{ name: "portal_toggle_servers" }];

  await expect(subject.findTool("portal_toggle_servers")).resolves.toBeUndefined();
  expect(subject.remoteCalls).toBe(0);
});

it("rejects a name outside the grant before loading the catalog or calling the endpoint", async () => {
  const subject = facet({ tools: ["allowed"] });
  subject.catalogResult = Promise.resolve({ tools: [], isPortal: false, truncated: false });

  await expect(subject.findTool("forbidden")).resolves.toBeUndefined();
  expect(subject.catalogReads).toBe(0);
  expect(subject.remoteCalls).toBe(0);
});

it("does not hydrate portal-native tools from a portal's incomplete catalog", async () => {
  const subject = facet();
  subject.catalogResult = Promise.resolve({ tools: [], isPortal: true, truncated: true });
  subject.remoteTools = [{ name: "portal_toggle_servers" }];

  await expect(subject.findTool("portal_toggle_servers")).resolves.toBeUndefined();
  expect(subject.remoteCalls).toBe(0);
});

it("bounds concurrent discovery work across distinct requests", async () => {
  const subject = facet();
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls = Array.from({ length: 12 }, () => subject.runDiscoveryTest(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
  }));

  await vi.waitFor(() => expect(active).toBe(4));
  expect(maxActive).toBe(4);
  release();
  await Promise.all(calls);
  expect(maxActive).toBe(4);
});

it("bounds concurrent catalog reads", async () => {
  const subject = facet();
  let active = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  subject.beforeCatalogRead = async () => {
    active++;
    await gate;
    active--;
  };

  const searches = Array.from({ length: 12 }, () => subject.searchTools("issues"));

  await vi.waitFor(() => expect(active).toBeGreaterThan(0));
  expect(active).toBe(4);
  release();
  await Promise.all(searches);
});
