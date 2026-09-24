// The MCP gatekeeper: connects any Model Context Protocol server as a Gadgets capability.
//
// Every call is either an observation or an approval-gated action, `readOnlyHint` decides which,
// writes are queued rather than performed inline, and per-tool TypeScript is generated from the
// server's schemas so Gadget code gets typed methods.
//
// The endpoint is whatever a user typed, so annotations never earn auto-approval here and a Gadget
// bound to it is owner-only, unless the deployment's vetted catalog says otherwise for that
// endpoint. See `sharing-policy.ts` and the README.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  stripTrailingSlashes,
  type AccountDescription,
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
import type { ToolCatalog } from "@gadgets/mcp-shared/client";
import {
  classifyTool,
  MAX_TOOLS_PER_SERVER,
  type ServerTrust,
} from "@gadgets/mcp-shared/tools";
import { bindingNameFragment, hostOf } from "@gadgets/mcp-shared/util";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpAccountBase, type ConnectedServer, type ConnectOutcome }
  from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import { fetchTools, withClient, type ConnectionAccount } from "@gadgets/mcp-shared/connection";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import {
  McpVerifierBase,
  mcpVerifierAccount,
  type McpVerifierApi,
  type ObserverAccount,
} from "@gadgets/mcp-shared/verifier";
import type { McpSharingPolicy } from "@gadgets/mcp-shared/sharing-policy";
import { looksLikePortal } from "@gadgets/mcp-shared/portal";
import {
  endpointOfResourceUrl,
  endpointTag,
  parseToolScope,
  requireCompleteCatalogForToolSelection,
  sameEndpoint,
  scopeAllows,
  validateToolScopeAgainstCatalog,
  type ToolScope,
} from "@gadgets/mcp-shared/scope";
import { validateCustomEndpoint } from "@gadgets/mcp-shared/endpoint";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import {
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
import { connectFormHtml } from "./connect-form.js";
import { serverIdFromEndpoint } from "./server-id.js";
import { companyResources, mcpResourceFor, mcpResources } from "./resources.js";
import {
  catalogEntryFor,
  catalogResource,
  companyServers,
  companySharingFor,
  ensureCatalog,
  keyInputName,
  personalServers,
  sharingFor,
  trustFor,
  type CatalogServer,
} from "./vetted-catalog.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import MCP_LOGO_SVG from "./mcp-logo.svg";
import MCP_SERVER_CONFIGURATOR_HTML from "./generated/server-configurator-ui.txt";
import type { McpServerConfiguratorRpc } from "./configurator/server-configurator-types";

const VENDOR_ID = "mcp";

// The trust tier is per endpoint now: an endpoint on the deployment's vetted catalog (see
// vetted-catalog.ts) may have its annotations drive auto-approval; anything user-supplied
// stays "byo" — it vouches only for itself. The tier says nothing about sharing: that is the
// catalog entry's separate `sharing` policy, and a Gadget bound to an unlisted endpoint is
// owner-only.

const logger = createLogger<McpLogFields>({ component: "gatekeeper.mcp", vendorId: VENDOR_ID });

const MCP_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(MCP_LOGO_SVG)}`;
const MCP_AVATAR: AvatarImage = { url: MCP_LOGO_URL };

// ---------------------------------------------------------------------------
// Helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mcp");
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the connect form and the OAuth callback.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpHttpRequest(req, {
      baseUrl: getBaseUrl(env),
      accountForId: id => ctx.exports.McpAccount.get(
        ctx.exports.McpAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, initiationNonce, path) => {
        if (request.method !== "GET" && request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        // A reconnect already knows its endpoint. Ignore a stale or malicious replacement URL.
        if (await account.hasEndpoint()) {
          return continueConnect(account, initiationNonce, null, env, path);
        }
        if (request.method === "GET") {
          if (!(await account.isAwaitingSelection(initiationNonce))) {
            return htmlResponse(INVALID_LINK_HTML, 400);
          }
          // A connect that started from a catalog pick in the Workshop already names its
          // endpoint; skip the form entirely.
          const requested = await account.requestedEndpoint();
          if (requested) return continueConnect(account, initiationNonce, requested, env, path);
          const catalog = await ensureCatalog(env);
          return htmlResponse(connectFormHtml(path, undefined, personalServers(catalog)));
        }
        const form = await request.formData();
        return continueConnect(
          account, initiationNonce, String(form.get("url") ?? ""), env, path,
          String(form.get("token") ?? "").trim() || null);
      },
    });
  },
};

// Validates the endpoint the user typed, then hands off to the account DO, which owns every
// credential. `endpointUrl` is null on a reconnect.
async function continueConnect(
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  endpointUrl: string | null,
  env: Env,
  formPath: string,
  preissuedToken: string | null = null,
): Promise<Response> {
  let target: ConnectedServer | null = null;

  if (endpointUrl !== null) {
    const validated = validateCustomEndpoint(env, endpointUrl);
    if (!validated.ok) {
      return htmlResponse(
        connectFormHtml(formPath, validated.reason, personalServers(await ensureCatalog(env))), 400);
    }
    // A catalog member seeds the curated display name; either way the handshake may report the
    // server's own name, and `auth` is a guess that `beginConnect` corrects to `"none"` if the
    // endpoint turns out to be public. Provenance stays "user" — the person chose this server —
    // so a catalog entry can never repoint an existing account the way a deployment portal can.
    // A supplied API key pins auth to "token": the probe then runs with the key (see
    // `McpAccountBase.probe`), and the key persists as this account's bearer.
    await ensureCatalog(env);
    const entry = catalogEntryFor(validated.url);
    target = {
      endpoint: validated.url,
      serverId: serverIdFromEndpoint(validated.url),
      serverName: entry?.name ?? hostOf(validated.url),
      provenance: "user",
      auth: preissuedToken ? "token" : "oauth",
    };
    if (preissuedToken &&
        !(await account.setPreissuedToken(initiationNonce, preissuedToken))) {
      return htmlResponse(INVALID_LINK_HTML, 400);
    }
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, target);
  } catch (err) {
    logger.warn("connect failed", { event: "connect.failed", error: err });
    return htmlResponse(connectFormHtml(
      formPath, err instanceof Error ? err.message : String(err)), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

// ---------------------------------------------------------------------------
// Vendor

// Which tenant a call is for. A shared connector serves many workshops: each binds with
// `props: { tenant }`, and the company's server keys (admin-entered setup) are keyed by it. A
// deployment running its own copy binds without props and keys by "".
type VendorProps = { tenant?: string };

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env, VendorProps> implements GatekeeperVendorIface {
  get #tenant(): string {
    return this.ctx.props?.tenant ?? "";
  }

  async describe(): Promise<VendorDescription> {
    const catalog = await ensureCatalog(this.env);
    const usable = await usableCompanyServers(this.env, this.ctx.exports, this.#tenant, catalog);
    return {
      displayName: "Custom MCP server",
      url: "https://modelcontextprotocol.io",
      logo: MCP_AVATAR,
      color: "#1a1d21",
      tagline: "Connect any MCP server by its URL",
      description:
        "Connect a Model Context Protocol server that isn't in the catalog by pasting its URL, " +
        "with an API key if it needs one. Its tools are discovered automatically: reads happen " +
        "straight away and anything that writes waits for approval. Catalog servers appear as " +
        "connectors of their own.",
      credentialScope: "personal",
      // Company servers are reached through an account the Workshop provisions for every
      // member; there is nothing to provision until the tenant can use at least one.
      autoProvisionsAccount: usable.length > 0,
      // The catalog decides which servers take a company key; the form only exists for those.
      supportsAdminSetup: companyKeyInputs(catalog).length > 0,
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const accountId = this.ctx.exports.McpAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const account = this.ctx.exports.McpAccount.get(accountId);
    await account.setCallback(callback, initiationNonce);
    // A single requested pattern naming a catalog server pre-selects that endpoint: the connect
    // popup then skips the URL form. Anything else (no patterns, several, the catch-alls) falls
    // through to the form, which offers the catalog too. A company server is never pre-selected:
    // it is reached through the provisioned account, not a personal connect.
    const patterns = options?.resourceUrlPatterns ?? [];
    if (patterns.length === 1) {
      await ensureCatalog(this.env);
      const entry = catalogEntryFor(patterns[0]);
      if (entry && entry.credential === "personal") await account.setRequestedEndpoint(entry.endpoint);
    }
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  /**
   * The company's account: one per member, minted by the Workshop for everyone once the tenant
   * can use a company server. It carries no credential of its own; every server it reaches runs
   * on the shared per-tenant account for that server (see `CompanyAccountImpl`).
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const usable = await usableCompanyServers(
      this.env, this.ctx.exports, this.#tenant, await ensureCatalog(this.env));
    if (usable.length === 0) {
      throw new Error("No company MCP server is set up for this deployment.");
    }
    return this.ctx.exports.CompanyAccountImpl({
      props: { tenant: this.#tenant },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    const catalog = await ensureCatalog(this.env);
    return [
      ...companyResources(
        await usableCompanyServers(this.env, this.ctx.exports, this.#tenant, catalog)),
      ...mcpResources(fetchOptions(this.env).allowInsecure === true, catalog),
    ];
  }

  /**
   * The company keys, one secret per catalog server that takes one. Servers needing no key are
   * usable as soon as the catalog lists them. "configured" means the tenant can use at least one
   * company server; the vendor as a whole is never hidden, since personal connections need no
   * setup.
   */
  async describeSetup(): Promise<VendorSetup> {
    const catalog = await ensureCatalog(this.env);
    const store = this.ctx.exports.VendorSetupStore.getByName(this.#tenant);
    const [values, updatedAt] = await Promise.all([store.getValues(), store.getUpdatedAt()]);
    const inputs = companyKeyInputs(catalog);
    const configured = inputs
      .filter((input) => values[input.name] !== undefined)
      .map((input) => ({ name: input.name, updatedAt: updatedAt[input.name] ?? 0 }));
    const usable = await usableCompanyServers(this.env, this.ctx.exports, this.#tenant, catalog,
      { fresh: true });
    return {
      description: "Company MCP servers from the catalog. Enter the company's API key for each " +
        "server your team should use; everyone then uses it without signing in. A server left " +
        "without a key stays hidden.",
      inputs,
      status: usable.length > 0 || inputs.length === 0 ? "configured" : "unconfigured",
      configured,
    };
  }

  async applySetup(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (!entries.length) throw new Error("No setup values provided.");
    const allowed = new Set(companyKeyInputs(await ensureCatalog(this.env)).map((i) => i.name));
    for (const [name, value] of entries) {
      if (!allowed.has(name)) {
        throw new Error(`Unknown setup value "${name}". Expected one of: ${[...allowed].join(", ")}.`);
      }
      if (typeof value !== "string" || !value.trim() || value.length > SETUP_VALUE_MAX_LENGTH) {
        throw new Error(`Setup value "${name}" must be a non-empty string of at most ${SETUP_VALUE_MAX_LENGTH} characters.`);
      }
    }
    const trimmed = Object.fromEntries(entries.map(([name, value]) => [name, value.trim()]));
    await this.ctx.exports.VendorSetupStore.getByName(this.#tenant).apply(trimmed, []);
    invalidateCompanyKeyCache(this.#tenant);
  }

  async clearSetup(names?: string[]): Promise<void> {
    const store = this.ctx.exports.VendorSetupStore.getByName(this.#tenant);
    if (names === undefined) {
      await store.clear();
    } else {
      const allowed = new Set(companyKeyInputs(await ensureCatalog(this.env)).map((i) => i.name));
      for (const name of names) {
        if (!allowed.has(name)) throw new Error(`Unknown setup value "${name}".`);
      }
      await store.remove(names);
    }
    invalidateCompanyKeyCache(this.#tenant);
  }

  async getTypeScriptTypes(): Promise<string> {
    // Vendor-level types are the transport-neutral base only; the per-tool `callTool` overloads are
    // generated per resource in `McpGatekeeperImpl.getTypeScriptTypes()`.
    return MCP_BASE_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account DO — owns the endpoint choice and every credential for it.

/**
 * One connected MCP server, for one user: `McpAccountBase` plus where this Worker lives and how it
 * mints an account. Nothing outside this object ever sees a credential.
 */
export class McpAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  /**
   * The connect handler needs both over RPC: one to decide whether to show the endpoint form, the
   * other to reject a stale link before doing any work.
   */
  async hasEndpoint(): Promise<boolean> {
    return this.hasConnectedServer();
  }

  async isAwaitingSelection(initiationNonce: string): Promise<boolean> {
    return this.awaitingSelection(initiationNonce);
  }

  /**
   * A catalog server chosen in the Workshop before the popup opened (see connectAccount). Only
   * an endpoint, never a credential; consumed by the connect handler to skip the URL form.
   */
  async setRequestedEndpoint(endpoint: string): Promise<void> {
    this.ctx.storage.kv.put("requestedCatalogEndpoint", endpoint);
  }

  /**
   * A user-supplied API key for a server that authenticates with a preissued bearer instead of
   * OAuth. Accepted only while the connect link's nonce is still live, so a stale or replayed
   * link cannot swap the credential; stored alongside the account's other secrets in this DO
   * (the abandonment alarm's deleteAll covers it) and read back through `staticToken`.
   */
  async setPreissuedToken(initiationNonce: string, token: string): Promise<boolean> {
    if (!(await this.awaitingSelection(initiationNonce))) return false;
    this.ctx.storage.kv.put("preissuedToken", token);
    return true;
  }

  /**
   * A personal account's own pasted key, or — for the shared per-tenant account behind a company
   * server — the key its administrator entered, read live from the setup store so a rotated key
   * takes effect without reconnecting and a withdrawn one fails closed. The catalog must still
   * name this endpoint as that server's, or the key is not sent (see `staticToken`'s contract).
   */
  protected override async staticToken(server: ConnectedServer): Promise<string | null> {
    const company = this.ctx.storage.kv.get<CompanyRef>("company");
    if (!company) return this.ctx.storage.kv.get<string>("preissuedToken") ?? null;
    const entry = companyServers(await ensureCatalog(this.env))
      .find((candidate) => candidate.id === company.serverId);
    if (!entry || !sameEndpoint(entry.endpoint, server.endpoint)) return null;
    if (entry.auth !== "token") return null;
    return (await loadCompanyKeys(this.ctx.exports, company.tenant))[keyInputName(entry.id)] ?? null;
  }

  async requestedEndpoint(): Promise<string | null> {
    return this.ctx.storage.kv.get<string>("requestedCatalogEndpoint") ?? null;
  }

  /**
   * Makes this the shared account for one company server of one tenant, connecting it with the
   * tenant's key (or nothing) on first use and restating the catalog's name and auth kind after.
   * Called by every member's `CompanyAccountImpl` before it mints a facet, so the connection is
   * established lazily and once; the Durable Object serialises concurrent first calls.
   */
  async ensureCompanyConnection(tenant: string, serverId: string): Promise<void> {
    const entry = companyServers(await ensureCatalog(this.env))
      .find((candidate) => candidate.id === serverId);
    if (!entry) throw new Error("This server is no longer set up for the company.");
    this.ctx.storage.kv.put<CompanyRef>("company", { tenant, serverId });
    await this.connectDirect({
      endpoint: entry.endpoint,
      serverId: serverIdFromEndpoint(entry.endpoint),
      serverName: entry.name,
      provenance: "deployment",
      auth: entry.auth === "token" ? "token" : "none",
    });
  }
}

// Which tenant's key a shared company account sends, and for which catalog server.
type CompanyRef = { tenant: string; serverId: string };

// The stable name of the shared account behind one company server for one tenant.
function companyAccountName(tenant: string, serverId: string): string {
  return `company:${tenant}:${serverId}`;
}

// ---------------------------------------------------------------------------
// Company servers: admin-entered keys and the account every member gets

const SETUP_VALUE_MAX_LENGTH = 2048;

/** One secret input per catalog company server that authenticates with a key. */
export function companyKeyInputs(catalog: CatalogServer[]): VendorSetupInput[] {
  return companyServers(catalog)
    .filter((server) => server.auth === "token")
    .map((server) => ({
      name: keyInputName(server.id),
      kind: "secret" as const,
      label: server.keyLabel ?? `${server.name} API key`,
      optional: true,
      ...(server.keyConsoleUrl ? { consoleUrl: server.keyConsoleUrl } : {}),
      setupSteps: [
        `Create an API key for the company's ${server.name} account` +
          (server.keyConsoleUrl ? ` at ${hostOf(server.keyConsoleUrl)}.` : "."),
        "Paste it here. It is stored in this connector and sent only to that server, as a bearer token.",
      ],
    }));
}

// The per-tenant company keys sit behind a Durable Object RPC and are consulted on every
// authenticated request, so they are cached per isolate briefly; writers reset their own isolate's
// entry and other isolates converge within the TTL.
const companyKeyCache = new Map<string, { values: Record<string, string>; expiresAt: number }>();
const COMPANY_KEY_CACHE_MS = 30_000;

type SetupStoreExports = {
  VendorSetupStore: { getByName(name: string): { getValues(): Promise<Record<string, string>> } };
};

function invalidateCompanyKeyCache(tenant: string): void {
  companyKeyCache.delete(tenant);
}

async function loadCompanyKeys(
  exports: SetupStoreExports, tenant: string, options?: { fresh?: boolean },
): Promise<Record<string, string>> {
  const cached = companyKeyCache.get(tenant);
  if (!options?.fresh && cached && Date.now() < cached.expiresAt) return cached.values;
  const values = await exports.VendorSetupStore.getByName(tenant).getValues();
  companyKeyCache.set(tenant, { values, expiresAt: Date.now() + COMPANY_KEY_CACHE_MS });
  return values;
}

/** The company servers this tenant can use now: key entered, or no key needed. */
async function usableCompanyServers(
  env: Env, exports: SetupStoreExports, tenant: string, catalog: CatalogServer[],
  options?: { fresh?: boolean },
): Promise<CatalogServer[]> {
  const servers = companyServers(catalog);
  if (servers.length === 0) return [];
  const keys = await loadCompanyKeys(exports, tenant, options);
  return servers.filter((server) => server.auth !== "token" || keys[keyInputName(server.id)]);
}

/**
 * Admin-entered company keys, one instance per tenant addressed by the tenant key ("" for the
 * owning deployment). Values never leave this worker except as presence + timestamps.
 */
export class VendorSetupStore extends DurableObject<Env> {
  getValues(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>("values") ?? {};
  }

  getUpdatedAt(): Record<string, number> {
    return this.ctx.storage.kv.get<Record<string, number>>("updatedAt") ?? {};
  }

  apply(values: Record<string, string>, requiredNames: string[]): void {
    const merged = { ...this.getValues(), ...values };
    const missing = requiredNames.filter((name) => merged[name] === undefined);
    if (missing.length) throw new Error(`Setup is incomplete: missing ${missing.join(", ")}.`);
    const updatedAt = this.getUpdatedAt();
    for (const name of Object.keys(values)) updatedAt[name] = Date.now();
    this.ctx.storage.kv.put("values", merged);
    this.ctx.storage.kv.put("updatedAt", updatedAt);
  }

  clear(): void {
    this.ctx.storage.kv.delete("values");
    this.ctx.storage.kv.delete("updatedAt");
  }

  remove(names: string[]): void {
    const values = this.getValues();
    const updatedAt = this.getUpdatedAt();
    for (const name of names) {
      delete values[name];
      delete updatedAt[name];
    }
    this.ctx.storage.kv.put("values", values);
    this.ctx.storage.kv.put("updatedAt", updatedAt);
  }
}

/**
 * The account the Workshop provisions for every member: the company's servers, reached without a
 * sign-in. It holds no credential. Each server it reaches runs on one shared `McpAccount` per
 * tenant and server (named by `companyAccountName`), connected on first use with the key the
 * administrator entered, so every member's facet on a server calls it as the same client.
 */
@validateRpc()
export class CompanyAccountImpl
  extends WorkerEntrypoint<Env, { tenant: string }>
  implements GatekeeperUser {
  get #tenant(): string {
    return this.ctx.props.tenant ?? "";
  }

  async #usable(): Promise<CatalogServer[]> {
    return usableCompanyServers(
      this.env, this.ctx.exports, this.#tenant, await ensureCatalog(this.env));
  }

  #sharedAccount(serverId: string): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.getByName(companyAccountName(this.#tenant, serverId));
  }

  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Company MCP servers",
      uniqueName: "Set up by your administrator",
      avatar: MCP_AVATAR,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return companyResources(await this.#usable());
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const requested = new URL(url);
    const entry = (await this.#usable())
      .find((server) => sameEndpoint(endpointOfResourceUrl(requested), server.endpoint));
    if (!entry) {
      throw new Error(`"${url}" is not a company MCP server set up on this deployment.`);
    }
    const scope = parseToolScope(requested);
    if (scope.serverId !== undefined) {
      throw new Error(
        `"${url}" scopes the grant to one server behind a gateway, which this integration does not ` +
        `do.`);
    }
    const account = this.#sharedAccount(entry.id);
    await account.ensureCompanyConnection(this.#tenant, entry.id);
    if (scope.tools !== undefined) {
      const selected = new Set(scope.tools);
      validateToolScopeAgainstCatalog(
        scope,
        selected.size === 0
          ? { tools: [], truncated: false }
          : await withClient(
            this.env,
            account,
            entry.endpoint,
            client => client.listMatchingToolIndex(
              selected.size,
              tool => selected.has(tool.name),
            ),
          ),
      );
    }
    const props: McpGatekeeperImplProps = {
      accountObjectId: account.id.toString(),
      endpoint: entry.endpoint,
      serverId: serverIdFromEndpoint(entry.endpoint),
      serverName: entry.name,
      scope,
      company: true,
    };
    return {
      class: this.ctx.exports.McpGatekeeperImpl({ props }),
      resource: catalogResource(entry),
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const entry = (await this.#usable())
      .find((server) => sameEndpoint(resourceUrlPattern, server.endpoint));
    if (!entry) throw new Error("This server is not set up for the company.");
    const account = this.#sharedAccount(entry.id);
    await account.ensureCompanyConnection(this.#tenant, entry.id);
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(this.env, account)),
    };
  }

  /** Nothing to revoke: the account holds no credential, and the shared ones are the admin's. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Company MCP servers are set up by an administrator under Admin → Integrations; there is nothing to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.McpCompanyVerifier({ props: { tenant: this.#tenant } });
  }
}

/**
 * The verifier a company account mints. A company binding admits observers by membership
 * (`companySharingFor`), never by replaying reads on the observer's own account, so no facet ever
 * asks this verifier which account it stands for.
 */
@validateRpc()
export class McpCompanyVerifier
  extends WorkerEntrypoint<Env, { tenant: string }>
  implements GatekeeperUserVerifier, McpVerifierApi {
  async observerAccount(): Promise<ObserverAccount> {
    throw new Error("A company MCP server is shared by membership, not by account.");
  }
}

// ---------------------------------------------------------------------------
// Account-facing interface

@validateRpc()
export class GatekeeperUserImpl
  extends McpGatekeeperUserBase<Env>
  implements GatekeeperUser {

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected [mcpGatekeeperUserContext]() {
    return { account: this.#account(), avatar: MCP_AVATAR, baseUrl: getBaseUrl(this.env) };
  }

  /**
   * The one resource this account can grant: the server it is connected to, reported as its
   * catalog entry when it has one and as the bring-your-own catch-all otherwise. An account is
   * bound to one endpoint, so advertising the whole catalog would offer grants it cannot mint.
   */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const server = await this.#account().getServer();
    return [mcpResourceFor(server.endpoint, await ensureCatalog(this.env))];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const server = await this.#account().getServer();

    // The account is bound to one endpoint, so a resource URL naming anything else is not this
    // account's to grant, and the protocol-specific resource pattern matches any URL so this is the whole
    // test. Compared in full rather than by origin: one host can front `/mcp` and `/mcp-v2` as
    // unrelated servers, and the facet calls the endpoint recorded on the account regardless.
    const requested = new URL(url, server.endpoint);
    if (!sameEndpoint(requested.toString(), server.endpoint)) {
      throw new Error(
        `This connection is for ${server.endpoint}, not ${endpointOfResourceUrl(requested)}.`);
    }

    // The fragment records how much of the endpoint this binding may call; see `scope.ts`. A
    // per-upstream-server scope belongs to the MCP Server Portals integration, and this gatekeeper
    // treats an endpoint as a single server, so it is refused rather than silently ignored.
    const scope = parseToolScope(requested);
    if (scope.serverId !== undefined) {
      throw new Error(
        `"${url}" scopes the grant to one server behind a gateway, which this integration does not ` +
        `do. Connect this endpoint through the MCP Server Portals integration instead.`);
    }
    if (scope.tools !== undefined) {
      const selected = new Set(scope.tools);
      validateToolScopeAgainstCatalog(
        scope,
        selected.size === 0
          ? { tools: [], truncated: false }
          : await withClient(
            this.env,
            this.#account(),
            server.endpoint,
            client => client.listMatchingToolIndex(
              selected.size,
              tool => selected.has(tool.name),
            ),
          ),
      );
    }

    const props: McpGatekeeperImplProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: server.endpoint,
      serverId: server.serverId,
      serverName: server.serverName,
      scope,
    };
    return {
      class: this.ctx.exports.McpGatekeeperImpl({ props }),
      resource: mcpResourceFor(server.endpoint, await ensureCatalog(this.env)),
    };
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(this.env, this.#account())),
    };
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.props.accountObjectId };
    return this.ctx.exports.McpVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier

// Minted by the *observer's* connected account and carries that account's id, so the facet's
// `addObserver` can learn which endpoint the observer connected to and replay the Gadget's reads
// on the observer's own credentials (see `McpFacetBase.addObserver`).
@validateRpc()
export class McpVerifier extends McpVerifierBase<Env> implements GatekeeperUserVerifier {
  protected [mcpVerifierAccount]() {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
class McpServerConfiguratorUI extends RpcTarget implements McpServerConfiguratorRpc {
  #env: Env;
  #account: DurableObjectStub<McpAccount>;
  #toolsPromise: Promise<ToolCatalog> | undefined;

  constructor(env: Env, account: DurableObjectStub<McpAccount>) {
    super();
    this.#env = env;
    this.#account = account;
  }

  async getEndpoint(): Promise<string> {
    return (await this.#account.getServer()).endpoint;
  }

  // One `tools/list` per configurator frame, shared by every question the form asks.
  #tools(): Promise<ToolCatalog> {
    this.#toolsPromise ??= (async () => {
      const server = await this.#account.getServer();
      return await fetchTools(this.#env, this.#account, server.endpoint);
    })();
    return this.#toolsPromise;
  }

  // Every tool the grant may cover, annotated with whether calls need approval.
  async listToolOptions(): Promise<ConfiguratorUIOption[]> {
    const [{ tools, truncated }, server] = await Promise.all([
      this.#tools(), this.#account.getServer(),
    ]);
    requireCompleteCatalogForToolSelection(truncated);
    // `fetchTools` lists with the ordinary catalog cap, so that is the cap reaching it would be
    // evidence of. Unlike the portal connector, this form refuses a truncated catalog outright
    // rather than surveying past it, so `truncated` is already known to be false here.
    const isPortal = looksLikePortal(tools, { truncated, cap: MAX_TOOLS_PER_SERVER });
    await ensureCatalog(this.#env);
    const trust = trustFor(this.#env, server.endpoint);

    return tools
      .filter(tool => scopeAllows({}, tool.name, isPortal))
      .map(tool => ({
        value: tool.name,
        title: tool.title ?? tool.name,
        subtitle: tool.description?.split(/\r?\n/)[0],
        // Surfaced here so the person granting can see, per tool, whether calls will interrupt them.
        meta: classifyTool(tool, trust).mode === "read" ? "read-only" : "needs approval",
      }));
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper facet

// Props identifying which server (and how much of it) a gatekeeper facet governs.
type McpGatekeeperImplProps = {
  accountObjectId: string;
  endpoint: string;
  // Display slug, for the binding name and session type; see `ConnectedServer.serverId`.
  serverId: string;
  serverName: string;
  // How much of the endpoint this binding may call. Empty means the whole endpoint, including tools
  // it publishes later.
  scope: ToolScope;
  // Runs on the company's shared account for this server rather than one person's: observers are
  // admitted by membership (see `companySharingFor`).
  company?: boolean;
};


export class McpGatekeeperImpl
  extends McpFacetBase<Env, McpGatekeeperImplProps, McpSessionImpl> {

  protected get log() {
    return logger.with({ serverHost: hostOf(this.ctx.props.endpoint) });
  }

  /**
   * Namespaces this binding's action-kind tags, so a pre-approval for one server's `create_issue`
   * cannot apply to another's.
   *
   * The whole endpoint is the identity, matching `sameEndpoint` and every other place a grant is
   * compared. `serverId` is a display slug and collides across hosts, but the origin is not enough
   * either: one host can front `/mcp` and `/mcp-v2` as unrelated servers, and keying on the origin
   * let an always-approve decision for a tool on one of them silently auto-apply to the same tool
   * name on the other. `endpointTag` is that identity, shared with `sameEndpoint` so the two
   * cannot drift.
   */
  protected get actionScopeTag(): string {
    return `mcp:${endpointTag(this.ctx.props.endpoint)}`;
  }

  /** The owner's account, which every call this facet makes runs on. */
  protected account(): ConnectionAccount {
    return this.accountById(this.ctx.props.accountObjectId);
  }

  /** Any account in this Worker's namespace, for replaying reads on an observer's own account. */
  protected accountById(accountObjectId: string): ConnectionAccount {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(accountObjectId));
  }

  /**
   * Sync by contract, so it answers from the last-known catalog and kicks a background refresh
   * when stale. A cold isolate answers "byo" — the conservative tier — and converges within one
   * call; the tool-catalog cache is keyed on the tier and refetches when it flips.
   */
  protected get trust(): ServerTrust {
    return trustFor(this.env, this.ctx.props.endpoint);
  }

  /**
   * Same shape as `trust`: the catalog's word on who may observe this endpoint, `owner-only`
   * until the catalog says otherwise.
   */
  protected get sharing(): McpSharingPolicy {
    return this.ctx.props.company
      ? companySharingFor(this.env, this.ctx.props.endpoint)
      : sharingFor(this.env, this.ctx.props.endpoint);
  }

  protected get sessionClass() {
    return McpSessionImpl;
  }

  protected get observerName(): string {
    return this.ctx.props.company
      ? `the company's MCP server ${hostOf(this.ctx.props.endpoint)}`
      : `the MCP server ${hostOf(this.ctx.props.endpoint)}`;
  }

  get serverName(): string {
    return this.ctx.props.serverName;
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    const { scope, serverName } = this.ctx.props;

    const counts = `${reads} read-only, ${tools.length - reads} requiring approval`;
    const plural = tools.length === 1 ? "" : "s";
    const snippet = scope.tools
      ? `${scope.tools.length} named MCP tool${scope.tools.length === 1 ? "" : "s"} on ` +
        `${serverName} \u2014 ${counts}. Other tools are refused.`
      : `All tools on ${serverName}; ${tools.length} tool definition${plural} shown here ` +
        `(${counts}).`;

    return {
      url: this.resourceUrl,
      title: scope.tools?.length === 1 ? `${serverName}: ${scope.tools[0]}` : serverName,
      snippet,
      suggestedBindingName: `MCP_${bindingNameFragment(this.ctx.props.serverId)}`,
      tsType: sessionTypeName(this.ctx.props.serverId, this.resourceUrl),
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    await ensureCatalog(this.env);
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: this.ctx.props.serverId,
      serverName: this.ctx.props.serverName,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: trustFor(this.env, this.ctx.props.endpoint),
      tools: await this.tools(),
    });
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed rather than used directly so `@validateRpc()` is applied in the file that hands the
// class to a Gadget, where it can be seen.
@validateRpc()
class McpSessionImpl extends McpSessionBase {}
