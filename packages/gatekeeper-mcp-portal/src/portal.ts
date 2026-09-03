// The MCP Server Portals gatekeeper: connects the deployment's own MCP portal as a Gadgets
// capability. A portal is one endpoint fronting many upstream MCP servers; Cloudflare's MCP Server
// Portals is the case this is written against.
//
// A sibling of the generic MCP connector rather than a mode of it: the endpoint is a deployment
// setting rather than user input, and a grant is scoped to one upstream server. Everything else is
// shared via `@gadgets/mcp-shared`. See the README.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  matchesResourceUrlPattern,
  stripTrailingSlashes,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
  type VendorSetup,
  type VendorSetupInput,
} from "@gadgets/workshop-shared/gatekeeper";
import { isValidToolName, type ToolIndex } from "@gadgets/mcp-shared/client";
import { MAX_TOOLS_PER_SERVER, type ServerTrust } from "@gadgets/mcp-shared/tools";
import { bindingNameFragment, hostOf } from "@gadgets/mcp-shared/util";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpAccountBase, type ConnectedServer, type ConnectOutcome }
  from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { withClient, type ConnectionAccount } from "@gadgets/mcp-shared/connection";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import {
  looksLikePortal,
  parsePortalServers,
  PORTAL_LIST_SERVERS_TOOL,
  reconcilePortalServers,
  type PortalServer,
  type PortalServerListing,
} from "@gadgets/mcp-shared/portal";
import {
  endpointOfResourceUrl,
  endpointTag,
  parseToolScope,
  sameEndpoint,
  validateToolScopeAgainstCatalog,
  type ToolScope,
} from "@gadgets/mcp-shared/scope";
import {
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "@gadgets/mcp-shared/html";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
  type McpGatekeeperUserProps,
} from "@gadgets/mcp-shared/user";
import {
  invalidatePortalSetupCache,
  loadPortalConfig,
  loadPortalToken,
  parsePortalConfig,
  PORTAL_SETUP_NAMES,
  portalAuthRequiresReconnect,
  portalCatalogValidationMode,
  portalResource,
  portalServer,
  portalTrust,
  requirePortalServerScope,
  type PortalSetupValues,
  isPortalToolGrantable,
  toolGrantOptions,
} from "./config.js";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import PORTAL_LOGO_SVG from "./portal-logo.svg";
import MCP_SERVER_CONFIGURATOR_HTML from "./generated/server-configurator-ui.txt";
import type { McpServerConfiguratorRpc } from "./configurator/server-configurator-types";

const VENDOR_ID = "mcp_portal";

// How many tools one survey of the portal may cover.
//
// Entries retain names only, maximizing how much of a large portal the 96 KiB listing budget can
// cover. This count cap independently bounds work when names are short; either cut is reported as
// `truncated`.
const MAX_PORTAL_TOOL_INDEX = 1000;

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.mcp-portal", vendorId: VENDOR_ID,
});


const PORTAL_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(PORTAL_LOGO_SVG)}`;
const PORTAL_AVATAR: AvatarImage = { url: PORTAL_LOGO_URL };

// Cloudflare orange, matching the Cloudflare Gateway glyph used as the mark. A deployment fronting
// some other aggregator should change both together.
const PORTAL_COLOR = "#f6821f";

// ---------------------------------------------------------------------------
// Helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mcp-portal");
}

async function listPortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServerListing> {
  const result = await withClient(env, account, endpoint,
    client => client.callTool(PORTAL_LIST_SERVERS_TOOL, {}));
  if (result.isError) throw new Error("The portal could not list its upstream servers.");
  return parsePortalServers(result);
}

async function tryListPortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServerListing | null> {
  try {
    return await listPortalServers(env, account, endpoint);
  } catch (err) {
    logger.warn("could not list portal servers", {
      event: "portal.servers.list.failed",
      serverHost: hostOf(endpoint),
      error: err,
    });
    return null;
  }
}

/**
 * Validates one portal-scoped resource URL, returning the scope it grants together with the upstream
 * server that scope names, when the portal reported one. Throws if the scope is not grantable.
 *
 * The fragment records how much of the portal this binding may call; see `scope.ts`. A grant that
 * names no upstream server would reach every system behind the portal, so it is refused here rather
 * than only in the form that normally builds these URLs.
 *
 * The server-list result is advisory metadata, so failing to obtain it is not fatal on its own. But
 * the endpoint still has to prove it implements the portal capability before a portal-scoped binding
 * can be minted, which is what the `findTool` probe below establishes.
 *
 * Each mode then fetches only the names validation still needs. Named grants prove each selected
 * name. A reported server needs no catalog scan; an unreported server needs one prefixed tool as
 * fallback evidence.
 */
async function validatePortalScope(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
  requested: URL,
): Promise<{ scope: ToolScope & { serverId: string }; upstream: PortalServer | undefined }> {
  const scope = parseToolScope(requested);
  requirePortalServerScope(scope);

  const listing = await tryListPortalServers(env, account, endpoint);
  if (listing === null) {
    const portalTool = await withClient(env, account, endpoint,
      client => client.findTool(PORTAL_LIST_SERVERS_TOOL));
    if (!portalTool) {
      throw new Error("The configured MCP endpoint does not expose the portal server-list tool.");
    }
  }

  const servers = listing?.servers ?? [];
  const requestedTools = new Set(scope.tools ?? []);
  let catalog: ToolIndex;
  switch (portalCatalogValidationMode(scope, servers)) {
    case "named-tools":
      catalog = await withClient(env, account, endpoint,
        client => client.listMatchingToolIndex(
          requestedTools.size,
          tool => requestedTools.has(tool.name),
        ));
      break;
    case "reported-server":
      catalog = { tools: [], truncated: false };
      break;
    case "server-evidence":
      catalog = await withClient(env, account, endpoint,
        client => client.listMatchingToolIndex(
          1,
          tool => isPortalToolGrantable(tool.name, scope.serverId),
        ));
      break;
  }
  return { scope, upstream: validateToolScopeAgainstCatalog(scope, catalog, servers) };
}

/**
 * The servers behind the portal, for the configurator's picker. Returns an empty list when the
 * endpoint is not a portal at all, but throws when it is one whose server list could not be read
 * completely: an incomplete picker would silently hide servers the user is entitled to grant.
 */
async function listAvailablePortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServer[]> {
  const reported = await tryListPortalServers(env, account, endpoint);
  if (reported?.complete) return reported.servers;

  const index = await withClient(env, account, endpoint,
    client => client.listToolIndex(MAX_PORTAL_TOOL_INDEX));
  if (!looksLikePortal(
    index.tools, { truncated: index.truncated, cap: MAX_PORTAL_TOOL_INDEX })) return [];
  if (index.truncated) {
    throw new Error("Could not retrieve the portal's complete server list. Try again.");
  }
  return reconcilePortalServers(reported?.servers ?? [], index.tools);
}

// HTTP handler. There is no page asking which server to connect, since the endpoint is configured,
// so the only browser round trip is the portal's own authorization.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpHttpRequest(req, {
      baseUrl: getBaseUrl(env),
      accountForId: id => ctx.exports.McpAccount.get(
        ctx.exports.McpAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, initiationNonce) => {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return continueConnect(account, initiationNonce, env, ctx.exports);
      },
    });
  },
};

// Hands off to the account DO, which owns every credential. The target comes from configuration, so
// this is the same call for a first connect and a reconnect.
async function continueConnect(
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  env: Env,
  exports: Cloudflare.Exports,
): Promise<Response> {
  // The account knows its tenant; the URL deliberately does not.
  const config = await loadPortalConfig(env, exports, await account.getTenant());
  if (!config) {
    return htmlResponse(errorPageHtml(
      "No MCP server portal is configured",
      "Ask an administrator to set this deployment's MCP server portal URL."), 503);
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, portalServer(config));
  } catch (err) {
    logger.warn("connect failed", { event: "connect.failed", error: err });
    return htmlResponse(errorPageHtml(
      "Could not connect", err instanceof Error ? err.message : String(err)), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

// ---------------------------------------------------------------------------
// Vendor

// Which tenant a call is for. A shared connector serves many workshops: each binds with
// `props: { tenant }`, and admin-entered setup (the portal endpoint and token) is keyed by it.
// A deployment running its own copy binds without props and keys by "". Accounts remember
// their tenant, so the HTTP flow — which has no binding props — resolves the same portal.
type VendorProps = { tenant?: string };

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env, VendorProps> implements GatekeeperVendorIface {
  get #tenant(): string {
    return this.ctx.props?.tenant ?? "";
  }

  async describe(): Promise<VendorDescription> {
    const config = await loadPortalConfig(this.env, this.ctx.exports, this.#tenant);
    return {
      displayName: config?.name ?? "Cloudflare MCP Server Portals",
      url: "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
      logo: PORTAL_AVATAR,
      color: PORTAL_COLOR,
      tagline: config
        ? `Connect a server behind ${hostOf(config.endpoint)}`
        : "No MCP server portal is configured",
      description:
        "Use the MCP servers this organization has approved, through its MCP server portal. Reads " +
        "happen straight away. Anything that writes waits for your approval.",
      supportsAdminSetup: true,
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    // Fail here rather than in the popup: an unconfigured portal should refuse the connect
    // attempt with a readable error instead of minting a URL that dead-ends.
    if (!(await loadPortalConfig(this.env, this.ctx.exports, this.#tenant))) {
      throw new Error("No MCP server portal is set up on this deployment. An administrator can set one up under Admin → Integrations.");
    }
    const accountId = this.ctx.exports.McpAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const account = this.ctx.exports.McpAccount.get(accountId);
    await account.setTenant(this.#tenant);
    await account.setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  /**
   * The one resource this connector offers, or none when unconfigured. Returning nothing is how the
   * connector hides itself from users: the Workshop drops a vendor that advertises no resources.
   * The admin panel keeps the row via supportsAdminSetup.
   */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = await loadPortalConfig(this.env, this.ctx.exports, this.#tenant);
    return config ? [portalResource(config)] : [];
  }

  async getTypeScriptTypes(): Promise<string> {
    // Vendor-level types are the transport-neutral base only. The per-tool `callTool` overloads are
    // generated per resource, from the chosen upstream server's own catalog; see
    // `McpGatekeeperImpl.getTypeScriptTypes()`.
    return MCP_BASE_TYPES;
  }

  async describeSetup(): Promise<VendorSetup> {
    const store = this.ctx.exports.VendorSetupStore.getByName(this.#tenant);
    const [values, updatedAt] = await Promise.all([store.getValues(), store.getUpdatedAt()]);
    const secretNames = new Set(SETUP_INPUTS.filter((input) => input.kind === "secret")
        .map((input) => input.name));
    const configured = PORTAL_SETUP_NAMES
        .filter((name) => values[name] !== undefined)
        .map((name) => ({
          name,
          updatedAt: updatedAt[name] ?? 0,
          ...(secretNames.has(name) ? {} : { value: values[name] }),
        }));
    const usable = await loadPortalConfig(this.env, this.ctx.exports, this.#tenant, { fresh: true }) !== null;
    return {
      description: "Point this deployment at your organization's MCP server portal. Your team " +
          "then connects to the servers behind it; writes always wait for approval.",
      inputs: SETUP_INPUTS,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
      status: usable ? "configured" : "unconfigured",
      configured,
    };
  }

  async applySetup(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("No setup values provided.");
    for (const [name, value] of entries) {
      if (!(PORTAL_SETUP_NAMES as string[]).includes(name)) {
        throw new Error(`Unknown setup value "${name}". Expected: ${PORTAL_SETUP_NAMES.join(", ")}.`);
      }
      if (typeof value !== "string" || !value.trim() || value.length > SETUP_VALUE_MAX_LENGTH) {
        throw new Error(`Setup value "${name}" must be a non-empty string of at most ${SETUP_VALUE_MAX_LENGTH} characters.`);
      }
    }
    const trimmed = Object.fromEntries(entries.map(([name, value]) => [name, value.trim()]));
    const store = this.ctx.exports.VendorSetupStore.getByName(this.#tenant);
    // Validate the merged result before storing, with reasons an administrator can act on —
    // parsePortalConfig's silent null is the right shape for hiding a misconfigured vendor,
    // not for rejecting a form.
    // Rebuilt key by key: the RPC-returned record carries a disposer symbol that a plain
    // spread would drag into the literal's type.
    const current = await store.getValues();
    const merged: PortalSetupValues = {};
    for (const name of PORTAL_SETUP_NAMES) {
      const value = trimmed[name] ?? current[name];
      if (value !== undefined) merged[name] = value;
    }
    const allowInsecure = fetchOptions(this.env).allowInsecure === true;
    const url = merged.MCP_PORTAL_URL?.trim() ?? "";
    let parsedUrl: URL | undefined;
    try { parsedUrl = new URL(url); } catch { /* handled below */ }
    if (!parsedUrl) throw new Error("MCP_PORTAL_URL must be a valid URL.");
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error("MCP_PORTAL_URL must not contain credentials; use the token field instead.");
    }
    if (parsedUrl.protocol !== "https:" && !(allowInsecure && parsedUrl.protocol === "http:")) {
      throw new Error("MCP_PORTAL_URL must be HTTPS.");
    }
    const auth = merged.MCP_PORTAL_AUTH?.trim().toLowerCase();
    if (auth !== undefined && !["oauth", "token", "none"].includes(auth)) {
      throw new Error('MCP_PORTAL_AUTH must be "oauth", "token", or "none".');
    }
    if (auth === "token" && !merged.MCP_PORTAL_TOKEN) {
      throw new Error('Authentication "token" needs a preissued bearer token.');
    }
    if (!parsePortalConfig(merged, allowInsecure)) {
      throw new Error("The portal setup is not usable as entered.");
    }
    await store.apply(trimmed, ["MCP_PORTAL_URL"]);
    invalidatePortalSetupCache(this.#tenant);
  }

  async clearSetup(): Promise<void> {
    await this.ctx.exports.VendorSetupStore.getByName(this.#tenant).clear();
    invalidatePortalSetupCache(this.#tenant);
  }
}

// The values an administrator supplies to set the portal up at runtime. Stored wholesale: when
// any are present they replace the deployment's MCP_PORTAL_* vars entirely, so the endpoint and
// its token can never mix sources.
const SETUP_INPUTS: VendorSetupInput[] = [
  {
    name: "MCP_PORTAL_URL",
    kind: "var",
    label: "Portal MCP endpoint URL",
    consoleUrl: "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
    setupSteps: [
      "Create an MCP server portal (for example, Cloudflare MCP Server Portals) fronting the servers your team may use.",
      "Paste the portal's MCP endpoint URL below (HTTPS).",
      "If the portal uses a preissued bearer token, set authentication to \"token\" and paste the token; leave \"oauth\" for portals that sign users in interactively.",
    ],
  },
  { name: "MCP_PORTAL_NAME", kind: "var", label: "Display name", optional: true },
  { name: "MCP_PORTAL_AUTH", kind: "var", label: "Authentication", optional: true, options: ["oauth", "token", "none"] },
  { name: "MCP_PORTAL_TOKEN", kind: "secret", label: "Preissued bearer token", optional: true },
];
const SETUP_VALUE_MAX_LENGTH = 2048;

// Admin-entered portal setup, one instance per tenant addressed by the tenant key ("" for the
// owning deployment).
// Secret values never leave this worker except as presence + timestamps; non-secret values
// (the endpoint URL, display name, auth mode) are shown back to administrators.
export class VendorSetupStore extends DurableObject<Env> {
  getValues(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>("values") ?? {};
  }

  getUpdatedAt(): Record<string, number> {
    return this.ctx.storage.kv.get<Record<string, number>>("updatedAt") ?? {};
  }

  // Merge-in a partial update, but refuse a merged result missing any required value — a
  // half-configured portal must stay unconfigured rather than half-working.
  apply(values: Record<string, string>, requiredNames: string[]): void {
    const merged = { ...this.getValues(), ...values };
    const missing = requiredNames.filter((name) => merged[name] === undefined);
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
// Account DO — owns the endpoint choice and every credential for it.

/**
 * One connected portal, for one user. Nothing outside this object ever sees a credential.
 *
 * The endpoint is a deployment setting rather than user input, so the preissued token is the only
 * real addition: a portal may be fronted by one instead of using OAuth.
 */
export class McpAccount extends McpAccountBase<Env> {
  // The tenant whose portal this account connects to, fixed at creation; "" (or unset, for
  // accounts created before tenants existed) is the owning deployment's own portal.
  #tenant(): string {
    return this.ctx.storage.kv.get<string>("tenant") ?? "";
  }

  async getTenant(): Promise<string> {
    return this.#tenant();
  }

  async setTenant(tenant: string): Promise<void> {
    this.ctx.storage.kv.put("tenant", tenant);
  }

  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: PortalUserProps = { accountObjectId: this.ctx.id.toString(), tenant: this.#tenant() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  /**
   * Scoped to the endpoint this account is connected to, never merely to what configuration says
   * today. The rule lives beside the configuration it guards, in `portalTokenOf`.
   */
  protected override staticToken(server: ConnectedServer): Promise<string | null> {
    return loadPortalToken(this.env, this.ctx.exports, server.endpoint, this.#tenant());
  }
}

// ---------------------------------------------------------------------------
// Account-facing interface

// The account capability carries its tenant so its own configuration reads need no round trip
// to the account object. Absent on stubs minted before tenants existed: those are the owning
// deployment's.
type PortalUserProps = McpGatekeeperUserProps & { tenant?: string };

@validateRpc()
export class GatekeeperUserImpl
  extends McpGatekeeperUserBase<Env, PortalUserProps>
  implements GatekeeperUser {

  get #tenant(): string {
    return this.ctx.props.tenant ?? "";
  }

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected [mcpGatekeeperUserContext]() {
    return { account: this.#account(), avatar: PORTAL_AVATAR, baseUrl: getBaseUrl(this.env) };
  }

  /**
   * The portal as currently configured, not as it was when this account connected. Repointing the
   * deployment therefore surfaces as a reconnect, via `getGatekeeperClassFor` refusing the old
   * endpoint, rather than as a Gadget quietly talking to a portal nobody chose.
   */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = await loadPortalConfig(this.env, this.ctx.exports, this.#tenant);
    return config ? [portalResource(config)] : [];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const config = await loadPortalConfig(this.env, this.ctx.exports, this.#tenant);
    if (!config) {
      throw new Error("This deployment has no MCP server portal configured.");
    }
    const server = await this.#account().getServer();
    const resource = portalResource(config);

    // The account connected to one portal and the deployment now names one; a repoint between the
    // two must surface as a reconnect. Otherwise this facet would be minted against the endpoint
    // frozen on the account while the deployment believes it configured a different one.
    if (!sameEndpoint(server.endpoint, config.endpoint)) {
      throw new Error(
        `This connection is for ${hostOf(server.endpoint)}, but this deployment's portal is now ` +
        `${hostOf(config.endpoint)}. Reconnect the account.`);
    }
    if (portalAuthRequiresReconnect(server.auth, config.auth)) {
      throw new Error("This deployment's portal authentication changed. Reconnect the account.");
    }

    // The account holds credentials for one portal, so a resource URL naming any other endpoint is
    // not this account's to grant. Compared in full rather than by origin: one host can front `/mcp`
    // and `/mcp-v2` as unrelated endpoints, and the facet always calls the endpoint recorded on the
    // account, so an origin-only test would honour a grant against a URL nobody connected to.
    const requested = new URL(url, server.endpoint);
    if (!sameEndpoint(requested.toString(), config.endpoint)) {
      throw new Error(
        `This connection is for ${config.endpoint}, not ` +
        `${endpointOfResourceUrl(requested)}.`);
    }
    if (!matchesResourceUrlPattern(resource.urlPattern, requested.toString())) {
      throw new Error(`"${url}" does not match this connection's resource type.`);
    }

    const account = this.#account();
    const { scope, upstream } = await validatePortalScope(
      this.env, account, server.endpoint, requested);

    const props: McpGatekeeperImplProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: server.endpoint,
      serverId: server.serverId,
      serverName: config.name,
      scopeServerName: upstream?.name ?? scope.serverId,
      scope,
    };
    return { class: this.ctx.exports.McpGatekeeperImpl({ props }), resource };
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(this.env, this.#account())),
    };
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.McpPortalVerifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier

// Required by the `GatekeeperUser` contract but never interrogated, since `addObserver` refuses
// everyone.
@validateRpc()
export class McpPortalVerifier
  extends WorkerEntrypoint<Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
class McpServerConfiguratorUI extends RpcTarget implements McpServerConfiguratorRpc {
  #env: Env;
  #account: DurableObjectStub<McpAccount>;
  #serverPromise: Promise<ConnectedServer> | undefined;
  #portalServersPromise: Promise<PortalServer[]> | undefined;

  constructor(env: Env, account: DurableObjectStub<McpAccount>) {
    super();
    this.#env = env;
    this.#account = account;
  }

  async getEndpoint(): Promise<string> {
    return (await this.#server()).endpoint;
  }

  #server(): Promise<ConnectedServer> {
    return this.#serverPromise ??= this.#account.getServer();
  }

  #portalServers(): Promise<PortalServer[]> {
    return this.#portalServersPromise ??= (async () => {
      const server = await this.#server();
      return listAvailablePortalServers(this.#env, this.#account, server.endpoint);
    })();
  }

  // Ask the portal for its server index without first loading every upstream tool. Empty for an
  // endpoint that does not implement the portal contract or currently fronts nothing; either case
  // leaves the form unsubmittable.
  async listServerOptions(): Promise<ConfiguratorUIOption[]> {
    return (await this.#portalServers()).map(upstream => ({
      value: upstream.id,
      title: upstream.name,
      // A server can be configured but switched off for this session, making a grant onto it valid
      // but presently empty, which the person choosing should see.
      meta: upstream.enabled ? undefined : "disabled in portal",
    }));
  }

  // Tools the grant may cover within one portal upstream server. The survey is checked before the
  // detailed catalog is fetched, and `toolGrantOptions` decides what each source says.
  async listToolOptions(serverId: string): Promise<ConfiguratorUIOption[]> {
    if (!isValidToolName(serverId)) return [];
    if (!(await this.#portalServers()).some(server => server.id === serverId)) return [];
    const server = await this.#server();
    const tools = await withClient(this.#env, this.#account, server.endpoint,
      client => client.listMatchingToolSummaries(
        MAX_TOOLS_PER_SERVER,
        tool => isPortalToolGrantable(tool.name, serverId),
      ));
    return toolGrantOptions({
      serverId,
      tools,
      trust: portalTrust(this.#env),
    });
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper facet

// Props identifying which server (and how much of it) a gatekeeper facet governs. The trust tier is
// absent: it is deployment configuration, read from `portalTrust(this.env)` at each point of use,
// since baking it into props would pin every binding to the setting on the day it was created.
type McpGatekeeperImplProps = {
  accountObjectId: string;
  endpoint: string;
  serverId: string;
  serverName: string;
  // Optional for facets minted before catalog-backed validation persisted the upstream display name.
  scopeServerName?: string;
  // How much of one upstream server this binding may call.
  scope: ToolScope & { serverId: string };
};

export class McpGatekeeperImpl
  extends McpFacetBase<Env, McpGatekeeperImplProps, McpSessionImpl> {

  protected get log() {
    return logger.with({
      serverId: this.ctx.props.serverId,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: portalTrust(this.env),
    });
  }

  protected account(): ConnectionAccount {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected get trust(): ServerTrust {
    return portalTrust(this.env);
  }

  protected get sessionClass() {
    return McpSessionImpl;
  }

  protected get observerName(): string {
    return this.#scopeLabel();
  }

  // How this binding's breadth reads to a human, for approval prompts and the bindings list.
  #scopeLabel(): string {
    const { scope, serverName, scopeServerName } = this.ctx.props;
    return `${serverName} / ${scopeServerName ?? scope.serverId}`;
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    const { scope } = this.ctx.props;
    const label = this.#scopeLabel();

    const counts = `${reads} read-only, ${tools.length - reads} requiring approval`;
    const plural = tools.length === 1 ? "" : "s";
    const snippet = scope.tools
      ? `${scope.tools.length} named MCP tool${scope.tools.length === 1 ? "" : "s"} on ` +
        `${label} \u2014 ${counts}. Other tools are refused.`
      : `All tools of the ${this.ctx.props.scopeServerName ?? scope.serverId} server on ` +
        `${this.ctx.props.serverName}; ${tools.length} tool definition${plural} shown here ` +
        `(${counts}). Use listTools({ search }) for others. Other servers are refused.`;

    return {
      url: this.resourceUrl,
      title: scope.tools?.length === 1 ? `${label}: ${scope.tools[0]}` : label,
      snippet,
      suggestedBindingName: `MCP_${bindingNameFragment(this.#bindingId())}`,
      tsType: sessionTypeName(this.#bindingId(), this.resourceUrl),
    };
  }

  // Identifies this binding's shape for naming. Server-scoped bindings get their own suggested name
  // and session type, so two bindings onto different servers of one portal do not collide and the
  // agent's type for the GitHub half of a portal is named after GitHub.
  //
  // This is a readable label, not an identity: two grants pinning different tools of one upstream
  // server produce the same id. `sessionTypeName` is what separates them, from the scoped resource
  // URL.
  #bindingId(): string {
    const { scope, serverId } = this.ctx.props;
    return `${serverId}-${scope.serverId}`;
  }

  /**
   * Namespaces persistent approval policy by both the readable binding shape and the exact portal
   * endpoint. A deployment repoint must not carry an always-approve decision to a different system
   * merely because both portals expose a tool with the same name.
   */
  protected get actionScopeTag(): string {
    return `mcp-portal:${endpointTag(this.ctx.props.endpoint)}:${this.#bindingId()}`;
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: this.#bindingId(),
      serverName: this.#scopeLabel(),
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: portalTrust(this.env),
      tools: await this.tools(),
    });
  }

  /**
   * The upstream server as the user should see it, not the portal's own name. The same label
   * `describe()` shows, so an approval prompt names the system being written to.
   */
  get serverName(): string {
    return this.#scopeLabel();
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed rather than used directly so `@validateRpc()` is applied in the file that hands the
// class to a Gadget, where it can be seen.
@validateRpc()
class McpSessionImpl extends McpSessionBase {}
