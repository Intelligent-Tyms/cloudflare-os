// The Organization Intelligence gatekeeper: connects a tenant's organization wiki (an external MCP
// server on the Tyms Intelligence cell) as an ambient capability of the workshop.
//
// Shape: an auto-provisioned singleton like Scheduled Tasks, configured per tenant like the MCP
// portal, speaking MCP through `@gadgets/mcp-shared`. The endpoint and the preissued assistant key
// arrive in the per-tenant setup store, written by Admin › Intelligence after provisioning (or
// pasted by an admin); once both are present the vendor auto-provisions one account per user, the
// account's singleton facet is installed into every workspace, and the wiki's precedence index is
// injected into the assistant's system prompt. See the README.
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
import { endpointTag, formatToolScope, type ToolScope } from "@gadgets/mcp-shared/scope";
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchOptions } from "@gadgets/mcp-shared/fetch";
import { cellFetchOptions } from "./cell.js";
import { escapeHtml, htmlResponse, PAGE_STYLE } from "@gadgets/mcp-shared/html";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import {
  assistantKeyOf,
  INTELLIGENCE_REQUIRED_NAMES,
  INTELLIGENCE_SERVER_ID,
  INTELLIGENCE_SETUP_NAMES,
  invalidateIntelligenceSetupCache,
  isConfigured,
  loadAssistantKey,
  loadIntelligenceConfig,
  loadIntelligenceSetup,
  parseIntelligenceConfig,
  SETUP_INPUTS,
  SETUP_VALUE_MAX_LENGTH,
  type IntelligenceConfig,
  type IntelligenceSetupValues,
} from "./config.js";
import {
  buildIntelligencePromptContext,
  fetchPrecedenceIndex,
  PrecedenceAuthError,
} from "./precedence.js";

const VENDOR_ID = "intelligence";
const DISPLAY_NAME = "Organization Intelligence";

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.intelligence", vendorId: VENDOR_ID,
});

// A book with a check mark: the wiki is the organization's reviewed record.
const INTELLIGENCE_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#0f766e" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/>' +
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="m9 10 2.2 2.2L15.5 8"/></svg>'),
};
const INTELLIGENCE_COLOR = "#0f766e";

/** How long a fetched precedence index serves new chats before it is fetched again. */
const PRECEDENCE_TTL_MS = 5 * 60_000;

// The wiki is a first-party server whose tool annotations are written by Tyms, so they may drive
// auto-approval: `readOnlyHint` tools run at once, `add_source` waits for approval.
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
    return loadIntelligenceSetup(this.ctx.exports, this.#tenant)
      .then(values => isConfigured(values, fetchOptions(this.env).allowInsecure === true));
  }

  /**
   * `autoProvisionsAccount` follows the setup: unconfigured, the vendor is a setup row in the admin
   * panel (the manual fallback); configured, it is an ambient capability the Workshop provisions for
   * every user on its next pass.
   */
  async describe(): Promise<VendorDescription> {
    const config = await loadIntelligenceConfig(this.env, this.ctx.exports, this.#tenant);
    return {
      displayName: DISPLAY_NAME,
      url: config?.wikiUrl ?? "https://tyms.ai/intelligence",
      logo: INTELLIGENCE_ICON,
      color: INTELLIGENCE_COLOR,
      tagline: config
        ? `Your organization's wiki at ${hostOf(config.endpoint)}`
        : "Provision it under Admin → Intelligence",
      description:
        "The organization's reviewed knowledge, synthesized from its own documents. The assistant " +
        "answers organization questions from it and cites the page. Anything it files back waits " +
        "for a reviewer.",
      autoProvisionsAccount: await this.#configured(),
      providesAuth: false,
      supportsAdminSetup: true,
    };
  }

  /** Mints a new opaque account capability; every user's account reaches the same tenant wiki. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    if (!(await this.#configured())) {
      throw new Error("Organization Intelligence is not set up for this workspace.");
    }
    return this.ctx.exports.IntelligenceAccount({
      props: { tenant: this.#tenant, accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Organization Intelligence is provisioned under Admin → Intelligence and has no connect flow.");
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
    const configured = INTELLIGENCE_SETUP_NAMES
      .filter(name => values[name] !== undefined)
      .map(name => ({
        name,
        updatedAt: updatedAt[name] ?? 0,
        ...(secretNames.has(name) ? {} : { value: values[name] }),
      }));
    const usable = isConfigured(
      await loadIntelligenceSetup(this.ctx.exports, this.#tenant, { fresh: true }),
      fetchOptions(this.env).allowInsecure === true);
    return {
      description: "Connect this workspace's assistant to the organization's wiki. Provisioning " +
        "under Admin → Intelligence fills this in; enter it by hand only to reconnect with a key " +
        "minted in the wiki console.",
      inputs: SETUP_INPUTS,
      status: usable ? "configured" : "unconfigured",
      configured,
    };
  }

  async applySetup(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("No setup values provided.");
    for (const [name, value] of entries) {
      if (!(INTELLIGENCE_SETUP_NAMES as string[]).includes(name)) {
        throw new Error(`Unknown setup value "${name}". Expected: ${INTELLIGENCE_SETUP_NAMES.join(", ")}.`);
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
    const merged: IntelligenceSetupValues = {};
    for (const name of INTELLIGENCE_SETUP_NAMES) {
      const value = trimmed[name] ?? current[name];
      if (value !== undefined) merged[name] = value;
    }
    const allowInsecure = fetchOptions(this.env).allowInsecure === true;
    const url = merged.INTELLIGENCE_MCP_URL ?? "";
    let parsedUrl: URL | undefined;
    try { parsedUrl = new URL(url); } catch { /* handled below */ }
    if (!parsedUrl) throw new Error("INTELLIGENCE_MCP_URL must be a valid URL.");
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error("INTELLIGENCE_MCP_URL must not contain credentials; use the key field instead.");
    }
    if (parsedUrl.protocol !== "https:" && !(allowInsecure && parsedUrl.protocol === "http:")) {
      throw new Error("INTELLIGENCE_MCP_URL must be HTTPS.");
    }
    if (!merged.INTELLIGENCE_ASSISTANT_KEY) {
      throw new Error("An assistant API key is required.");
    }
    if (!merged.INTELLIGENCE_ASSISTANT_KEY.startsWith("oik_")) {
      throw new Error("The assistant API key should start with \"oik_\".");
    }
    if (!parseIntelligenceConfig(merged, allowInsecure)) {
      throw new Error("The wiki setup is not usable as entered.");
    }
    await store.apply(trimmed, INTELLIGENCE_REQUIRED_NAMES);
    invalidateIntelligenceSetupCache(this.#tenant);
  }

  async clearSetup(): Promise<void> {
    await this.ctx.exports.VendorSetupStore.getByName(this.#tenant).clear();
    invalidateIntelligenceSetupCache(this.#tenant);
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
   * half-configured wiki must stay unconfigured rather than half-working.
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

// The scoped resource URL the facet is minted for. There is exactly one per wiki (the whole
// endpoint), and it doubles as the discriminator in the session type name, so the account and the
// facet compute it the same way.
function resourceUrlOf(config: IntelligenceConfig): string {
  return formatToolScope(config.endpoint, {});
}

@validateRpc()
export class IntelligenceAccount
  extends WorkerEntrypoint<Env, AccountProps>
  implements GatekeeperUser
{
  #config(): Promise<IntelligenceConfig | null> {
    return loadIntelligenceConfig(this.env, this.ctx.exports, this.ctx.props.tenant);
  }

  /**
   * Ambient while the tenant is configured. After `clearSetup` (deprovision) the account persists
   * but declares neither singleton nor UI, so the Workshop stops offering the binding.
   */
  async describe(): Promise<AccountDescription> {
    const config = await this.#config();
    if (!config) return { displayName: DISPLAY_NAME, avatar: INTELLIGENCE_ICON };
    return {
      displayName: DISPLAY_NAME,
      avatar: INTELLIGENCE_ICON,
      singleton: { tsType: sessionTypeName(INTELLIGENCE_SERVER_ID, resourceUrlOf(config)) },
      providesUi: { title: "Wiki", icon: INTELLIGENCE_ICON, externalUrl: config.wikiUrl },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<IntelligenceSessionImpl>>> {
    const config = await this.#config();
    if (!config) throw new Error("Organization Intelligence is not set up for this workspace.");
    return this.ctx.exports.IntelligenceGatekeeper({
      props: { tenant: this.ctx.props.tenant, endpoint: config.endpoint, scope: {} },
    });
  }

  /** Fallback for a direct load of the in-app page; the nav entry itself opens the wiki. */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const config = await this.#config();
    const ui = new RpcStub(new IntelligenceAppUi(config?.wikiUrl ?? null));
    return { iframeHtml: appHtml(config?.wikiUrl ?? null), ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Organization Intelligence has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Organization Intelligence has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Nothing to revoke: the account holds no credential. The key lives in the tenant's setup. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Organization Intelligence has no connect flow; reconnect it under Admin → Intelligence.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.IntelligenceVerifier({});
  }
}

@validateRpc()
class IntelligenceAppUi extends RpcTarget {
  constructor(private readonly wikiUrl: string | null) {
    super();
  }

  async getWikiUrl(): Promise<string | null> {
    return this.wikiUrl;
  }
}

function appHtml(wikiUrl: string | null): string {
  const body = wikiUrl
    ? `<p>The organization wiki opens in its own tab.</p>` +
      `<p><a href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener noreferrer">Open the wiki</a></p>`
    : `<p>Organization Intelligence is not set up for this workspace. An administrator can ` +
      `provision it under Admin → Intelligence.</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${DISPLAY_NAME}</title>` +
    `<style>${PAGE_STYLE}</style></head><body><main><h1>${DISPLAY_NAME}</h1>${body}</main></body></html>`;
}

// Required by the `GatekeeperUser` contract. Observers are admitted freely (the wiki is
// tenant-wide readable content), so the verifier is never interrogated.
@validateRpc()
export class IntelligenceVerifier
  extends WorkerEntrypoint<Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Gatekeeper facet — the wiki's MCP server as one workspace binding

type FacetProps = {
  tenant: string;
  endpoint: string;
  scope: ToolScope;
};

export class IntelligenceGatekeeper
  extends McpFacetBase<Env, FacetProps, IntelligenceSessionImpl> {

  protected get log() {
    return logger.with({
      serverId: INTELLIGENCE_SERVER_ID,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: TRUST,
    });
  }

  /**
   * The wiki's MCP server is stateless and the key is tenant-wide, so there is no account Durable
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
          throw new Error("Organization Intelligence is not connected for this workspace. An " +
            "administrator can reconnect it under Admin → Intelligence.");
        }
        return { authorization: key, sessionId: null, generation: 0 };
      },
      async assertConnectionCurrent(): Promise<void> {},
      async setMcpSessionId(): Promise<boolean> {
        return true;
      },
      async noteCredentialsExpired(): Promise<void> {
        log.warn("the wiki rejected the assistant key", { event: "credentials.rejected" });
      },
    };
  }

  protected get trust(): ServerTrust {
    return TRUST;
  }

  /**
   * The wiki records who acted, not just which key: when the Workshop knows the person behind the
   * session it mints a signed actor assertion (start.tyms.ai's key, verified by the cell) and every
   * call of the session carries it. Without one, reads still work under the assistant key alone;
   * the cell decides whether a write needs the person (REQUIRE_ACTOR_ASSERTION).
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

  /** Every MCP request to a wiki host goes through the cell binding (see cell.ts). */
  override call<T>(
    fn: (client: McpClient) => Promise<T>,
    options?: WithClientOptions,
  ): Promise<T> {
    return super.call(fn, { ...cellFetchOptions(this.env, this.endpoint), ...options });
  }

  protected get sessionClass() {
    return IntelligenceSessionImpl;
  }

  protected get observerName(): string {
    return DISPLAY_NAME;
  }

  /** Approval policy is per wiki endpoint, so a reconnect to a different wiki starts afresh. */
  protected get actionScopeTag(): string {
    return `intelligence:${endpointTag(this.ctx.props.endpoint)}`;
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
      snippet: `The organization's wiki: search, read pages and the precedence index, add sources ` +
        `(${reads} read-only, ${tools.length - reads} requiring approval).`,
      suggestedBindingName: "INTELLIGENCE",
      tsType: sessionTypeName(INTELLIGENCE_SERVER_ID, this.resourceUrl),
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: INTELLIGENCE_SERVER_ID,
      serverName: DISPLAY_NAME,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: TRUST,
      tools: await this.tools(),
    });
  }

  /**
   * Everything read through this binding is the tenant's wiki, readable by every member of the
   * workspace, so observers are admitted rather than refused as the base does for personal MCP
   * connections.
   */
  override async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /**
   * The precedence index for the system prompt. Cached in this facet's storage for a few minutes
   * and until the tenant's setup changes (provision, reconnect and deprovision all write the store,
   * which bumps its timestamps). The Workshop snapshots the result once per chat, so a refresh
   * reaches new chats only.
   */
  async getAgentPromptContext(
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentPromptContext | null> {
    const { tenant, endpoint } = this.ctx.props;
    const values = await loadIntelligenceSetup(this.ctx.exports, tenant);
    const allowInsecure = fetchOptions(this.env).allowInsecure === true;
    const config = parseIntelligenceConfig(values, allowInsecure);
    const key = config && assistantKeyOf(values, allowInsecure, endpoint);
    if (!config || !key) return null;

    const stamps = await this.ctx.exports.VendorSetupStore.getByName(tenant).getUpdatedAt();
    const setupStamp = Math.max(0, ...Object.values(stamps));
    const cached = this.ctx.storage.kv.get<PrecedenceCache>("precedence");
    let markdown: string;
    if (cached && cached.setupStamp === setupStamp
        && Date.now() - cached.fetchedAt < PRECEDENCE_TTL_MS) {
      markdown = cached.markdown;
    } else {
      try {
        markdown = await fetchPrecedenceIndex(config, key, {
          ...fetchOptions(this.env), timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          ...cellFetchOptions(this.env, config.precedenceUrl),
        });
        this.ctx.storage.kv.put<PrecedenceCache>("precedence",
          { markdown, fetchedAt: Date.now(), setupStamp });
      } catch (err) {
        // A stale index beats none: the wiki changes slowly and the block is only context.
        this.log.warn("could not fetch the precedence index", {
          event: err instanceof PrecedenceAuthError
            ? "precedence.fetch.rejected" : "precedence.fetch.failed",
          error: err,
        });
        if (!cached) return null;
        markdown = cached.markdown;
      }
    }

    await authorizer.authorizeObservation({
      title: "Organization Intelligence precedence index",
      description: `Provided the organization wiki's precedence index (${config.wikiUrl}) as ` +
        "assistant context.",
    });
    return boundAgentPromptContext(buildIntelligencePromptContext(markdown, config));
  }
}

type PrecedenceCache = { markdown: string; fetchedAt: number; setupStamp: number };

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed so `@validateRpc()` is applied in the file that hands the class to a Gadget.
@validateRpc()
class IntelligenceSessionImpl extends McpSessionBase {}

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
