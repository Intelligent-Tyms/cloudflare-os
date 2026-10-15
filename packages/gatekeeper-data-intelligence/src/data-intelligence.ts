// The Data Intelligence gatekeeper: connects a tenant's Data Intelligence organization (an external
// MCP server on the Tyms Data Intelligence cell) as an ambient capability of the workshop, so the
// assistant can answer questions from the tenant's databases and uploaded files.
//
// A sibling of gatekeeper-intelligence and the same shape: an auto-provisioned singleton,
// configured per tenant through the setup store, speaking MCP through `@gadgets/mcp-shared`. The
// endpoint and the preissued assistant key are written by Admin › Intelligence after provisioning
// (or pasted by an admin); once both are present the vendor auto-provisions one account per user
// and the account's singleton facet is installed into every workspace. See the README.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  boundAgentPromptContext,
  type AccountDescription,
  type AgentPromptContext,
  type AppUiContext,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUiFrame,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ObservationAuthorizer,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type SessionContext,
  type VendorDescription,
  type VendorSetup,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ServerTrust } from "@gadgets/mcp-shared/tools";
import { hostOf } from "@gadgets/mcp-shared/util";
import type { McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import type { ConnectionAccount, McpConnection, WithClientOptions } from "@gadgets/mcp-shared/connection";
import type { McpClient } from "@gadgets/mcp-shared/client";
import { McpSessionBase, type McpSessionContext } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import type { McpSharingPolicy } from "@gadgets/mcp-shared/sharing-policy";
import { endpointTag, formatToolScope, type ToolScope } from "@gadgets/mcp-shared/scope";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import { cellFetchOptions } from "./cell.js";
import { escapeHtml, htmlResponse, PAGE_STYLE } from "@gadgets/mcp-shared/html";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import {
  DATA_INTELLIGENCE_REQUIRED_NAMES,
  DATA_INTELLIGENCE_SERVER_ID,
  DATA_INTELLIGENCE_SETUP_NAMES,
  invalidateDataIntelligenceSetupCache,
  isConfigured,
  loadAssistantKey,
  loadDataIntelligenceConfig,
  loadDataIntelligenceSetup,
  parseDataIntelligenceConfig,
  SETUP_INPUTS,
  SETUP_VALUE_MAX_LENGTH,
  type DataIntelligenceConfig,
  type DataIntelligenceSetupValues,
} from "./config.js";
import { DATA_INTELLIGENCE_PROMPT_CONTEXT } from "./prompt.js";

// The Workshop derives a vendor id from the binding name (GATEKEEPER_DATA_INTELLIGENCE), as it
// does for `mcp_portal`.
const VENDOR_ID = "data_intelligence";
const DISPLAY_NAME = "Data Intelligence";

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.data-intelligence", vendorId: VENDOR_ID,
});

// A database cylinder: the tenant's own data, read where it lives.
const DATA_INTELLIGENCE_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6"/>' +
    '<path d="M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6"/></svg>'),
};
const DATA_INTELLIGENCE_COLOR = "#1d4ed8";

// Data Intelligence is a first-party server whose tool annotations are written by Tyms, so they
// may drive auto-approval: its `readOnlyHint` tools (catalog, context, dry_run, run_sql) run at
// once; `save_report`, the one tool that writes, waits for approval.
const TRUST: ServerTrust = "vetted";

// ---------------------------------------------------------------------------
// Vendor

// Which tenant a call is for. The shared connector serves many workshops: each binds with
// `props: { tenant }`, and the setup store is keyed by it. A deployment running its own copy
// binds without props and keys by "".
type VendorProps = { tenant?: string };

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env, VendorProps> implements GatekeeperVendorIface {
  get #tenant(): string {
    return this.ctx.props?.tenant ?? "";
  }

  #configured(): Promise<boolean> {
    return loadDataIntelligenceSetup(this.ctx.exports, this.#tenant)
      .then(values => isConfigured(values, fetchOptions(this.env).allowInsecure === true));
  }

  /**
   * `autoProvisionsAccount` follows the setup: unconfigured, the vendor is a setup row in the admin
   * panel (the manual fallback); configured, it is an ambient capability the Workshop provisions for
   * every user on its next pass.
   */
  async describe(): Promise<VendorDescription> {
    const config = await loadDataIntelligenceConfig(this.env, this.ctx.exports, this.#tenant);
    return {
      displayName: DISPLAY_NAME,
      url: config?.consoleUrl ?? "https://tyms.ai/intelligence",
      logo: DATA_INTELLIGENCE_ICON,
      color: DATA_INTELLIGENCE_COLOR,
      tagline: config
        ? `Your organization's data at ${hostOf(config.endpoint)}`
        : "Provision it under Admin → Intelligence",
      description:
        "Governed, read-only SQL over the organization's databases and uploaded files. The " +
        "assistant answers data questions from them and says where each number came from. " +
        "Nothing is copied out of the source, and a report it drafts waits for approval.",
      autoProvisionsAccount: await this.#configured(),
      providesAuth: false,
      supportsAdminSetup: true,
    };
  }

  /** Mints a new opaque account capability; every user's account reaches the same organization. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    if (!(await this.#configured())) {
      throw new Error("Data Intelligence is not set up for this workspace.");
    }
    return this.ctx.exports.DataIntelligenceAccount({
      props: { tenant: this.#tenant, accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Data Intelligence is provisioned under Admin → Intelligence and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return MCP_BASE_TYPES;
  }

  async describeSetup(): Promise<VendorSetup> {
    const store = this.ctx.exports.VendorSetupStore.getByName(this.#tenant);
    const [values, updatedAt] = await Promise.all([store.getValues(), store.getUpdatedAt()]);
    const secretNames = new Set(SETUP_INPUTS.filter(input => input.kind === "secret")
      .map(input => input.name));
    const configured = DATA_INTELLIGENCE_SETUP_NAMES
      .filter(name => values[name] !== undefined)
      .map(name => ({
        name,
        updatedAt: updatedAt[name] ?? 0,
        ...(secretNames.has(name) ? {} : { value: values[name] }),
      }));
    const usable = isConfigured(
      await loadDataIntelligenceSetup(this.ctx.exports, this.#tenant, { fresh: true }),
      fetchOptions(this.env).allowInsecure === true);
    return {
      description: "Connect this workspace's assistant to the organization's Data Intelligence. " +
        "Provisioning under Admin → Intelligence fills this in; enter it by hand only to " +
        "reconnect with a key minted in the Data Intelligence console.",
      inputs: SETUP_INPUTS,
      status: usable ? "configured" : "unconfigured",
      configured,
    };
  }

  async applySetup(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("No setup values provided.");
    for (const [name, value] of entries) {
      if (!(DATA_INTELLIGENCE_SETUP_NAMES as string[]).includes(name)) {
        throw new Error(`Unknown setup value "${name}". Expected: ${DATA_INTELLIGENCE_SETUP_NAMES.join(", ")}.`);
      }
      if (typeof value !== "string" || !value.trim() || value.length > SETUP_VALUE_MAX_LENGTH) {
        throw new Error(`Setup value "${name}" must be a non-empty string of at most ${SETUP_VALUE_MAX_LENGTH} characters.`);
      }
    }
    const trimmed = Object.fromEntries(entries.map(([name, value]) => [name, value.trim()]));
    const store = this.ctx.exports.VendorSetupStore.getByName(this.#tenant);
    // Validate the merged result with reasons an administrator can act on; the parser's silent
    // null is the right shape for hiding a misconfigured vendor, not for rejecting a form.
    const current = await store.getValues();
    const merged: DataIntelligenceSetupValues = {};
    for (const name of DATA_INTELLIGENCE_SETUP_NAMES) {
      const value = trimmed[name] ?? current[name];
      if (value !== undefined) merged[name] = value;
    }
    const allowInsecure = fetchOptions(this.env).allowInsecure === true;
    const url = merged.DATA_INTELLIGENCE_MCP_URL ?? "";
    let parsedUrl: URL | undefined;
    try { parsedUrl = new URL(url); } catch { /* handled below */ }
    if (!parsedUrl) throw new Error("DATA_INTELLIGENCE_MCP_URL must be a valid URL.");
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error("DATA_INTELLIGENCE_MCP_URL must not contain credentials; use the key field instead.");
    }
    if (parsedUrl.protocol !== "https:" && !(allowInsecure && parsedUrl.protocol === "http:")) {
      throw new Error("DATA_INTELLIGENCE_MCP_URL must be HTTPS.");
    }
    if (!merged.DATA_INTELLIGENCE_ASSISTANT_KEY) {
      throw new Error("An assistant API key is required.");
    }
    if (!merged.DATA_INTELLIGENCE_ASSISTANT_KEY.startsWith("dik_")) {
      throw new Error("The assistant API key should start with \"dik_\".");
    }
    if (!parseDataIntelligenceConfig(merged, allowInsecure)) {
      throw new Error("The Data Intelligence setup is not usable as entered.");
    }
    await store.apply(trimmed, DATA_INTELLIGENCE_REQUIRED_NAMES);
    invalidateDataIntelligenceSetupCache(this.#tenant);
  }

  async clearSetup(): Promise<void> {
    await this.ctx.exports.VendorSetupStore.getByName(this.#tenant).clear();
    invalidateDataIntelligenceSetupCache(this.#tenant);
  }
}

/**
 * Admin-entered (or provisioning-written) setup, one instance per tenant addressed by the tenant
 * key ("" for the owning deployment). Secret values never leave this worker except as presence +
 * timestamps. A copy of the portal's store; lifting it into mcp-shared is a follow-up.
 */
export class VendorSetupStore extends DurableObject<Env> {
  getValues(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>("values") ?? {};
  }

  getUpdatedAt(): Record<string, number> {
    return this.ctx.storage.kv.get<Record<string, number>>("updatedAt") ?? {};
  }

  /**
   * Merge-in a partial update, but refuse a merged result missing any required value: a
   * half-configured connector must stay unconfigured rather than half-working.
   */
  apply(values: Record<string, string>, requiredNames: string[]): void {
    const merged = { ...this.getValues(), ...values };
    const missing = requiredNames.filter(name => merged[name] === undefined);
    if (missing.length) {
      throw new Error(`Setup is incomplete: missing ${missing.join(", ")}.`);
    }
    const updatedAt = this.getUpdatedAt();
    for (const name of Object.keys(values)) updatedAt[name] = Date.now();
    this.ctx.storage.kv.put("values", merged);
    this.ctx.storage.kv.put("updatedAt", updatedAt);
  }

  clear(): void {
    this.ctx.storage.kv.delete("values");
    this.ctx.storage.kv.delete("updatedAt");
  }
}

// ---------------------------------------------------------------------------
// Account — one per user, holding no credential of its own: the tenant's key is in the store.

type AccountProps = { tenant: string; accountId: string };

// The scoped resource URL the facet is minted for. There is exactly one per organization (the
// whole endpoint), and it doubles as the discriminator in the session type name, so the account and the
// facet compute it the same way.
function resourceUrlOf(config: DataIntelligenceConfig): string {
  return formatToolScope(config.endpoint, {});
}

@validateRpc()
export class DataIntelligenceAccount
  extends WorkerEntrypoint<Env, AccountProps>
  implements GatekeeperUser
{
  #config(): Promise<DataIntelligenceConfig | null> {
    return loadDataIntelligenceConfig(this.env, this.ctx.exports, this.ctx.props.tenant);
  }

  /**
   * Ambient while the tenant is configured. After `clearSetup` (deprovision) the account persists
   * but declares neither singleton nor UI, so the Workshop stops offering the binding.
   */
  async describe(): Promise<AccountDescription> {
    const config = await this.#config();
    if (!config) return { displayName: DISPLAY_NAME, avatar: DATA_INTELLIGENCE_ICON };
    return {
      displayName: DISPLAY_NAME,
      avatar: DATA_INTELLIGENCE_ICON,
      singleton: { tsType: sessionTypeName(DATA_INTELLIGENCE_SERVER_ID, resourceUrlOf(config)) },
      providesUi: { title: "Data", icon: DATA_INTELLIGENCE_ICON, externalUrl: config.consoleUrl },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<DataIntelligenceSessionImpl>>> {
    const config = await this.#config();
    if (!config) throw new Error("Data Intelligence is not set up for this workspace.");
    return this.ctx.exports.DataIntelligenceGatekeeper({
      props: { tenant: this.ctx.props.tenant, endpoint: config.endpoint, scope: {} },
    });
  }

  /** Fallback for a direct load of the in-app page; the nav entry itself opens the workbench. */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const config = await this.#config();
    const ui = new RpcStub(new DataIntelligenceAppUi(config?.consoleUrl ?? null));
    return { iframeHtml: appHtml(config?.consoleUrl ?? null), ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Data Intelligence has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Data Intelligence has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Nothing to revoke: the account holds no credential. The key lives in the tenant's setup. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Data Intelligence has no connect flow; reconnect it under Admin → Intelligence.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.DataIntelligenceVerifier({});
  }
}

@validateRpc()
class DataIntelligenceAppUi extends RpcTarget {
  constructor(private readonly consoleUrl: string | null) {
    super();
  }

  async getConsoleUrl(): Promise<string | null> {
    return this.consoleUrl;
  }
}

function appHtml(consoleUrl: string | null): string {
  const body = consoleUrl
    ? `<p>The Data Intelligence workbench opens in its own tab.</p>` +
      `<p><a href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener noreferrer">Open the workbench</a></p>`
    : `<p>Data Intelligence is not set up for this workspace. An administrator can ` +
      `provision it under Admin → Intelligence.</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${DISPLAY_NAME}</title>` +
    `<style>${PAGE_STYLE}</style></head><body><main><h1>${DISPLAY_NAME}</h1>${body}</main></body></html>`;
}

// Required by the `GatekeeperUser` contract. Observers are admitted freely (see `addObserver`),
// so the verifier is never interrogated.
@validateRpc()
export class DataIntelligenceVerifier
  extends WorkerEntrypoint<Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Gatekeeper facet — the organization's MCP server as one workspace binding

type FacetProps = {
  tenant: string;
  endpoint: string;
  scope: ToolScope;
};

export class DataIntelligenceGatekeeper
  extends McpFacetBase<Env, FacetProps, DataIntelligenceSessionImpl> {

  protected get log() {
    return logger.with({
      serverId: DATA_INTELLIGENCE_SERVER_ID,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: TRUST,
    });
  }

  /**
   * The cell's MCP server is stateless and the key is tenant-wide, so there is no account Durable
   * Object: credentials come straight from the setup store, scoped to this facet's endpoint, and
   * nothing about a session is persisted.
   */
  protected account(): ConnectionAccount {
    const { tenant, endpoint } = this.ctx.props;
    const env = this.env;
    const exports = this.ctx.exports;
    const log = this.log;
    return {
      async getConnection(forEndpoint: string): Promise<McpConnection> {
        const key = await loadAssistantKey(env, exports, forEndpoint, tenant);
        if (!key || forEndpoint !== endpoint) {
          throw new Error("Data Intelligence is not connected for this workspace. An " +
            "administrator can reconnect it under Admin → Intelligence.");
        }
        return { authorization: key, sessionId: null, generation: 0 };
      },
      async assertConnectionCurrent(): Promise<void> {},
      async setMcpSessionId(): Promise<boolean> {
        return true;
      },
      async noteCredentialsExpired(): Promise<void> {
        log.warn("the cell rejected the assistant key", { event: "credentials.rejected" });
      },
    };
  }

  /** One tenant-wide key, so an observer's "own account" is the same one the owner used. */
  protected accountById(): ConnectionAccount {
    return this.account();
  }

  protected get trust(): ServerTrust {
    return TRUST;
  }

  /**
   * One tenant-wide assistant key reads on everyone's behalf, and what it may read is decided in
   * Data Intelligence (the key's connections, each connection's policy and masks), not per
   * Workshop user; reads are never replayed on anyone's account.
   */
  protected get sharing(): McpSharingPolicy {
    return "public";
  }

  /**
   * The query log records who asked, not just which key: when the Workshop knows the person behind
   * the session it mints a signed actor assertion (start.tyms.ai's key, verified by the cell) and
   * every call of the session carries it. Without one, calls still work under the assistant key
   * alone; the cell decides whether it needs the person (REQUIRE_ACTOR_ASSERTION).
   */
  protected override async sessionContext(
    context?: SessionContext,
  ): Promise<McpSessionContext | undefined> {
    const assertion = context?.actor?.assertion;
    if (!assertion) return undefined;
    try {
      const minted = await assertion.mint();
      if (!minted) return undefined;
      return { callOptions: { headers: { "x-tyms-actor": minted.token } } };
    } catch (err) {
      this.log.warn("could not mint an actor assertion; calling as the assistant only", {
        event: "actor-assertion.unavailable", error: err,
      });
      return undefined;
    }
  }

  /** Every MCP request to a tenant host goes through the cell binding (see cell.ts). */
  override call<T>(
    fn: (client: McpClient) => Promise<T>,
    options?: WithClientOptions,
  ): Promise<T> {
    return super.call(fn, { ...cellFetchOptions(this.env, this.endpoint), ...options });
  }

  protected get sessionClass() {
    return DataIntelligenceSessionImpl;
  }

  protected get observerName(): string {
    return DISPLAY_NAME;
  }

  /** Approval policy is per endpoint, so a reconnect to a different organization starts afresh. */
  protected get actionScopeTag(): string {
    return `data-intelligence:${endpointTag(this.ctx.props.endpoint)}`;
  }

  get serverName(): string {
    return DISPLAY_NAME;
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    return {
      url: this.resourceUrl,
      title: DISPLAY_NAME,
      snippet: `The organization's databases and uploaded files: list connections, read the ` +
        `catalog and context, run read-only SQL, draft reports ` +
        `(${reads} read-only, ${tools.length - reads} requiring approval).`,
      suggestedBindingName: "DATA_INTELLIGENCE",
      tsType: sessionTypeName(DATA_INTELLIGENCE_SERVER_ID, this.resourceUrl),
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: DATA_INTELLIGENCE_SERVER_ID,
      serverName: DISPLAY_NAME,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: TRUST,
      tools: await this.tools(),
    });
  }

  /**
   * Everything read through this binding was read with the tenant's one assistant key, which
   * every member of the workspace shares, so observers are admitted rather than refused as the
   * base does for personal MCP connections.
   */
  override async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /**
   * How to use the binding, for the system prompt. The text is this package's own and says
   * nothing about the tenant (no connection, table or value is read to produce it), so there is
   * no observation to authorize; what the organization holds reaches the agent only through the
   * tools, each call recorded. Null while unconfigured, so a dormant account adds nothing.
   */
  async getAgentPromptContext(
    _authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentPromptContext | null> {
    const { tenant, endpoint } = this.ctx.props;
    if (!(await loadAssistantKey(this.env, this.ctx.exports, endpoint, tenant))) return null;
    return boundAgentPromptContext(DATA_INTELLIGENCE_PROMPT_CONTEXT);
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed so `@validateRpc()` is applied in the file that hands the class to a Gadget.
@validateRpc()
class DataIntelligenceSessionImpl extends McpSessionBase {}

/**
 * No HTTP surface: there is no OAuth flow and no connect page. The shared deployment still routes
 * `/gatekeeper/intelligence/*` here, so answer rather than hang.
 */
export default {
  async fetch(): Promise<Response> {
    return htmlResponse(
      `<!DOCTYPE html><html><body><p>${DISPLAY_NAME} has no web pages.</p></body></html>`, 404);
  },
};
