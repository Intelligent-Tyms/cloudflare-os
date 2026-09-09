// Shared mechanics of an MCP gatekeeper facet. Connector-owned subclasses retain their Wrangler
// identity, props, labels, trust source, and account lookup.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import type {
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
  SessionContext,
} from "@gadgets/workshop-shared/gatekeeper";

import { ActionStore, REVERT_UNSUPPORTED_MESSAGE } from "./action-store.js";
import {
  CATALOG_TTL_MS,
  HydratedTools,
  scopedCatalog,
  type ScopedCatalog,
} from "./catalog.js";
import type { McpClient, McpToolCallResult } from "./client.js";
import {
  withClient,
  type ConnectionAccount,
  type ConnectionEnv,
  type WithClientOptions,
} from "./connection.js";
import type { McpLog } from "./log.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./fetch.js";
import { formatToolScope, sameEndpoint, scopeAllows, type ToolScope } from "./scope.js";
import { matchesToolQuery, toolQueryTerms, MAX_SEARCH_RESULTS } from "./tool-search.js";
import {
  McpSessionBase,
  type McpSessionContext,
  type McpSessionHost,
  type StoredAction,
} from "./session.js";
import { installToolMethods } from "./session-methods.js";
import { MAX_LOGGED_READS, ObserverStore, type LoggedRead } from "./observer-store.js";
import {
  observerEndpointMismatchMessage,
  observerLogOverflowMessage,
  observerRefusalMessage,
  observerReplayFailureMessage,
  type McpSharingPolicy,
} from "./sharing-policy.js";
import { safeServerText } from "./util.js";
import type { McpVerifierApi } from "./verifier.js";
import {
  actionKindFor,
  classifyTool,
  type ClassifiedTool,
  type ServerTrust,
} from "./tools.js";

type FacetProps = {
  endpoint: string;
  scope: ToolScope;
};

type SessionConstructor<Session extends McpSessionBase> = new (
  host: McpSessionHost,
  queue: RpcStub<ApprovalQueue>,
  context?: McpSessionContext,
) => Session;

const MAX_CONCURRENT_DISCOVERIES = 4;
const MAX_QUEUED_DISCOVERIES = 32;

// Replaying the read log on an observer's account: how many calls run at once, and how long the
// whole replay may take before the observer is refused as unverifiable rather than admitted.
const REPLAY_CONCURRENCY = 4;
const REPLAY_BUDGET_MS = 60_000;

// How long an observer's full-log verification stands before their next open replays everything
// again. Reads made in between are replayed as they happen (see `recordRead`), so this interval
// only bounds how long a revoked account keeps passing on what it verified earlier.
const FULL_REVERIFY_INTERVAL_MS = 15 * 60_000;

/** Why one replayed read did not succeed on an observer's account. */
type ReplayFailure = { toolName: string; reason: string };

/** Common session, catalog, action, and sharing behavior for connector-owned MCP facets. */
export abstract class McpFacetBase<
  Env extends ConnectionEnv,
  Props extends FacetProps,
  Session extends McpSessionBase,
> extends DurableObject<Env, Props> implements Gatekeeper<Session>, McpSessionHost {
  #catalogPromise: Promise<ScopedCatalog> | undefined;
  #toolsFetchedAt = 0;
  #toolsTrust: ServerTrust | undefined;
  #actionStore: ActionStore | undefined;
  #observerStore: ObserverStore | undefined;
  #hydrated = new HydratedTools();
  #activeDiscoveries = 0;
  #waitingDiscoveries: Array<() => void> = [];

  #actions(): ActionStore {
    return this.#actionStore ??= new ActionStore(this.ctx.storage.sql);
  }

  #observers(): ObserverStore {
    return this.#observerStore ??= new ObserverStore(this.ctx.storage.sql);
  }

  /** Connector-owned logger carrying the facet's safe identifying fields. */
  protected abstract get log(): McpLog;

  /** Current trust tier, read whenever catalog classification is used. */
  protected abstract get trust(): ServerTrust;

  /** Current sharing policy, read whenever an observer is admitted or a read is recorded. */
  protected abstract get sharing(): McpSharingPolicy;

  /** Connector-decorated session class exposed through RPC. */
  protected abstract get sessionClass(): SessionConstructor<Session>;

  /** Namespace preventing approval policy from crossing resource boundaries. */
  protected abstract get actionScopeTag(): string;

  /** Human-readable resource named when refusing an observer. */
  protected abstract get observerName(): string;

  /** Connector-owned account capability used for endpoint calls. */
  protected abstract account(): ConnectionAccount;

  /** An observer's own account, by the id their verifier reported. Same Worker, same namespace. */
  protected abstract accountById(accountObjectId: string): ConnectionAccount;

  /** Human-readable server label used in observations and action prompts. */
  abstract get serverName(): string;

  /** Describes the connector-specific resource represented by this facet. */
  abstract describe(): Promise<ResourceDescription>;

  /** Generates the connector-specific TypeScript API for this facet. */
  abstract getTypeScriptTypes(): Promise<string>;

  /** The endpoint this facet is authorized to call. */
  get endpoint(): string {
    return this.ctx.props.endpoint;
  }

  /** The tool scope this facet is authorized to expose. */
  get scope(): ToolScope {
    return this.ctx.props.scope;
  }

  /** Canonical resource URL for this facet's endpoint and scope. */
  protected get resourceUrl(): string {
    return formatToolScope(this.endpoint, this.scope);
  }

  /** Returns this facet's scoped catalog and endpoint kind. */
  protected catalog(deadline?: number): Promise<ScopedCatalog> {
    const trust = this.trust;
    if (!this.#catalogPromise || this.#toolsTrust !== trust
        || Date.now() - this.#toolsFetchedAt > CATALOG_TTL_MS) {
      this.#toolsFetchedAt = Date.now();
      this.#toolsTrust = trust;
      const load = (operationDeadline: number) => scopedCatalog({
        store: this.ctx.storage.kv,
        log: this.log,
        env: this.env,
        account: this.account(),
        endpoint: this.endpoint,
        scope: this.scope,
        trust,
        deadline: operationDeadline,
      });
      const loading = deadline === undefined ? this.runDiscovery(load) : load(deadline);
      this.#catalogPromise = loading.catch(err => {
        this.#catalogPromise = undefined;
        throw err;
      });
    }
    return this.#catalogPromise;
  }

  /** Returns this facet's scoped and classified tool definitions. */
  async tools(): Promise<ClassifiedTool[]> {
    return (await this.catalog()).tools;
  }

  /** Runs Gadget-triggered catalog I/O within one facet-wide concurrency bound. */
  protected async runDiscovery<T>(operation: (deadline: number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + DEFAULT_REQUEST_TIMEOUT_MS;
    if (this.#activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) {
      if (this.#waitingDiscoveries.length >= MAX_QUEUED_DISCOVERIES) {
        throw new Error("Too many MCP discovery requests are already in progress.");
      }
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.#waitingDiscoveries.indexOf(resume);
          if (index >= 0) this.#waitingDiscoveries.splice(index, 1);
          reject(new Error("Timed out waiting to discover MCP tools."));
        }, Math.max(0, deadline - Date.now()));
        this.#waitingDiscoveries.push(resume);
      });
    } else {
      this.#activeDiscoveries++;
    }

    try {
      return await operation(deadline);
    } finally {
      const next = this.#waitingDiscoveries.shift();
      if (next) next();
      else this.#activeDiscoveries--;
    }
  }

  /** Searches the endpoint for granted tools by name, title, and description. */
  async searchTools(query: string): Promise<ClassifiedTool[]> {
    const terms = toolQueryTerms(query);
    return this.runDiscovery(async deadline => {
      const catalog = await this.catalog(deadline);
      if (!catalog.truncated) {
        return catalog.tools.filter(entry => matchesToolQuery(entry.tool, terms))
          .slice(0, MAX_SEARCH_RESULTS);
      }
      const { isPortal } = catalog;
      const tools = await this.call(
        client => client.listMatchingToolSummaries(
          MAX_SEARCH_RESULTS,
          tool => scopeAllows(this.scope, tool.name, isPortal) && matchesToolQuery(tool, terms),
        ),
        { deadline },
      );
      return tools.map(tool => classifyTool(tool, this.trust));
    });
  }

  /** Resolves one granted tool, fetching it when the described catalog omitted it. */
  async findTool(name: string): Promise<ClassifiedTool | undefined> {
    // Grant restrictions can be enforced without loading anything. A portal-native exclusion needs
    // the endpoint kind below, except for a server scope, which by definition belongs to a portal.
    if (!scopeAllows(this.scope, name, this.scope.serverId !== undefined)) return undefined;

    return this.runDiscovery(async deadline => {
      const catalog = await this.catalog(deadline);
      if (!scopeAllows(this.scope, name, catalog.isPortal)) return undefined;
      const described = catalog.tools.find(entry => entry.tool.name === name);
      if (described) return described;
      if (!catalog.truncated) return undefined;

      const load = (candidate: string) =>
        this.call(client => client.findTool(candidate), { deadline });
      const tool = await this.#hydrated.resolve(name, load);
      return tool && classifyTool(tool, this.trust);
    });
  }

  /** Returns action kinds that this facet's current catalog permits auto-approving. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return (await this.tools())
      .filter(entry => entry.autoApprovable)
      .map(entry => actionKindFor(this.actionScopeTag, entry.tool.name));
  }

  /**
   * What this facet's sessions carry into their calls, derived from what the Workshop knows about
   * the session being opened (e.g. the person an agent acts for). The default carries nothing;
   * a connector whose server verifies per-person identity overrides it. Called once per session,
   * while the Workshop's stubs in `context` are still live.
   */
  protected async sessionContext(
    _context?: SessionContext,
  ): Promise<McpSessionContext | undefined> {
    return undefined;
  }

  /** Starts a session with generated per-tool methods when the catalog is available. */
  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>, context?: SessionContext,
  ): Promise<Session> {
    let SessionClass = this.sessionClass;
    try {
      SessionClass = installToolMethods(SessionClass, await this.tools());
    } catch (err) {
      this.log.warn("starting session without per-tool methods", {
        event: "session.tool-methods.unavailable", error: err,
      });
    }
    return new SessionClass(this, approvalQueue.dup(), await this.sessionContext(context));
  }

  /**
   * Admits an observer under the endpoint's sharing policy (see `sharing-policy.ts`): refused
   * outright under `owner-only`, admitted unchecked under `public`, and under `same-account`
   * admitted only once their own account on this endpoint has repeated every read this facet has
   * made. The Workshop calls this on every open, so a verified observer is re-checked against
   * whatever was read since, and against the whole log again once the last full pass is stale.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const policy = this.sharing;
    const store = this.#observers();
    const now = Date.now();

    if (policy === "owner-only") {
      store.deleteObserver(id);
      throw new Error(observerRefusalMessage(this.observerName));
    }
    if (policy === "public") {
      store.putObserver({ observerId: id, accountObjectId: "", verifiedThrough: 0, verifiedAt: now });
      return;
    }

    // Minted by this connector's own account entrypoint (see `McpVerifierBase`); the Workshop
    // only ever passes a verifier back to the gatekeeper that created it.
    const { accountObjectId, endpoint } =
      await (user as unknown as McpVerifierApi).observerAccount();
    if (!sameEndpoint(endpoint, this.endpoint)) {
      store.deleteObserver(id);
      throw new Error(observerEndpointMismatchMessage(this.observerName, this.#nameEndpoint(endpoint)));
    }
    if (store.overflowed()) {
      store.deleteObserver(id);
      throw new Error(observerLogOverflowMessage(this.observerName));
    }

    const existing = store.getObserver(id);
    const stale = !existing
      || existing.accountObjectId !== accountObjectId
      || now - existing.verifiedAt > FULL_REVERIFY_INTERVAL_MS;
    const reads = store.readsAfter(stale ? 0 : existing.verifiedThrough);
    const failure = await this.#replay(this.accountById(accountObjectId), reads);
    if (failure) {
      store.deleteObserver(id);
      this.log.info("observer refused", {
        event: "observer.refused", toolName: failure.toolName,
      });
      throw new Error(
        observerReplayFailureMessage(this.observerName, failure.toolName, failure.reason));
    }

    const verifiedThrough = reads.length > 0
      ? reads[reads.length - 1].id
      : stale ? 0 : existing.verifiedThrough;
    store.putObserver({
      observerId: id,
      accountObjectId,
      verifiedThrough,
      verifiedAt: stale ? now : existing.verifiedAt,
    });
  }

  /** Forgets an observer. Their account is not contacted. */
  async removeObserver(id: string): Promise<void> {
    this.#observers().deleteObserver(id);
  }

  /**
   * Records one read-only call and returns the observers who must not see its result, if any.
   *
   * Every read is logged, whatever the policy, so the log is complete should the policy change.
   * Under `same-account` a read that is new to an admitted observer is replayed on their account
   * before the result is handed over; whoever fails is excluded, and the Workshop decides whether
   * that blocks the observation. Under `owner-only` any observer still on the roster is excluded,
   * since the policy no longer admits them; under `public` nobody is.
   */
  async recordRead(toolName: string, args: Record<string, unknown>): Promise<string[] | undefined> {
    const store = this.#observers();
    const recorded = store.recordRead(toolName, args);
    if (recorded.overflow) {
      this.log.warn(`read log overflowed past ${MAX_LOGGED_READS} distinct reads`, {
        event: "observer.log.overflow",
      });
    }

    const observers = store.listObservers();
    if (observers.length === 0) return undefined;

    const policy = this.sharing;
    if (policy === "public") return undefined;
    if (policy === "owner-only" || recorded.overflow) {
      return observers.map(observer => observer.observerId);
    }

    const excluded: string[] = [];
    for (const observer of observers) {
      if (observer.verifiedThrough >= recorded.id) continue;
      if (observer.accountObjectId === "") {
        // Admitted under `public` before the policy tightened; their next open verifies them.
        excluded.push(observer.observerId);
        continue;
      }
      const reads = store.readsAfter(observer.verifiedThrough);
      const failure = await this.#replay(this.accountById(observer.accountObjectId), reads);
      if (failure) {
        excluded.push(observer.observerId);
        this.log.info("observer excluded from a read", {
          event: "observer.excluded", toolName: failure.toolName,
        });
        continue;
      }
      store.putObserver({ ...observer, verifiedThrough: reads[reads.length - 1]?.id ?? observer.verifiedThrough });
    }
    return excluded.length > 0 ? excluded : undefined;
  }

  // Repeats each read on `account`, a few at a time, stopping at the first that does not succeed.
  // A tool result flagged `isError` counts as a failure: that is how servers report "not yours to
  // see" as often as a 403 is.
  async #replay(
    account: ConnectionAccount, reads: LoggedRead[],
  ): Promise<ReplayFailure | undefined> {
    const deadline = Date.now() + REPLAY_BUDGET_MS;
    for (let start = 0; start < reads.length; start += REPLAY_CONCURRENCY) {
      const batch = reads.slice(start, start + REPLAY_CONCURRENCY);
      const outcomes = await Promise.all(batch.map(read => this.#replayOne(account, read, deadline)));
      const failure = outcomes.find(outcome => outcome !== undefined);
      if (failure) return failure;
    }
    return undefined;
  }

  async #replayOne(
    account: ConnectionAccount, read: LoggedRead, deadline: number,
  ): Promise<ReplayFailure | undefined> {
    if (Date.now() >= deadline) {
      return { toolName: read.toolName, reason: "verification timed out" };
    }
    try {
      const result = await this.replayRead(account, read, deadline);
      if (result.isError === true) {
        const text = result.content
          ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map(block => block.text)
          .join(" ");
        return { toolName: read.toolName, reason: safeServerText(text) ?? "the server returned an error" };
      }
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { toolName: read.toolName, reason: safeServerText(message) ?? "the call failed" };
    }
  }

  /** Makes one logged read on `account`. Separate so tests can stand in for the endpoint. */
  protected replayRead(
    account: ConnectionAccount, read: LoggedRead, deadline: number,
  ): Promise<McpToolCallResult> {
    return withClient(
      this.env, account, this.endpoint,
      client => client.callTool(read.toolName, read.args),
      { deadline });
  }

  #nameEndpoint(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return "another server";
    }
  }

  /** Stages an MCP action for approval. */
  stageAction(toolName: string, args: Record<string, unknown>): StoredAction {
    return this.#actions().stage(toolName, args);
  }

  /** Discards an action whose approval submission failed. */
  discardStagedAction(id: number): void {
    this.#actions().discard(id);
  }

  /** Looks up a staged or completed action. */
  lookupAction(id: number): StoredAction | undefined {
    return this.#actions().get(id);
  }

  /** Applies an approved action without retrying an outcome-unknown write. */
  async applyAction(action: number): Promise<void> {
    await this.#actions().apply(
      action, fn => this.call(fn, { retryOnExpiry: false }), this.log);
  }

  /** Rejects a pending action. */
  async rejectAction(action: number): Promise<void> {
    this.#actions().reject(action);
  }

  /** Reports that MCP actions cannot be reverted. */
  async revertAction(_action: number): Promise<{ message: string }> {
    return { message: REVERT_UNSUPPORTED_MESSAGE };
  }

  /** Runs a call against this facet's endpoint and account. */
  call<T>(
    fn: (client: McpClient) => Promise<T>,
    options?: WithClientOptions,
  ): Promise<T> {
    return withClient(this.env, this.account(), this.endpoint, fn, options);
  }

  /** Namespaces one tool's approval kind to this facet. */
  actionKindFor(toolName: string): ActionKind {
    return actionKindFor(this.actionScopeTag, toolName);
  }
}
