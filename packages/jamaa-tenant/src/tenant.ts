// One Worker for a whole Jamaa tenant. A tenant stack is four Workers (router, workshop-backend,
// gatekeeper-context and the channels gatekeeper) joined by service bindings. Workers for Platforms
// rejects service bindings between user Workers in a dispatch namespace, so each tenant becomes a
// single script that exports every class of every part, and the bindings between parts become
// `ctx.exports` loopbacks into that same script.
//
// The parts' code is unchanged: they still read `env.GATEKEEPER_CONTEXT`, `env.CHANNELS` and so on.
// `tenantClass` gives every exported class an env with those bindings filled in, and the default
// handler does the router's job, calling each part's own fetch handler directly.

import { prefixedKv } from "./prefixed-kv.js";

/**
 * A class the runtime constructs with `(ctx, env)`: a Durable Object or a WorkerEntrypoint. A
 * TypeScript mixin base must take `any[]`.
 */
export type TenantClass = new (...args: any[]) => object;

/**
 * A service binding between parts of a stack, and the entrypoint of this script that replaces it.
 * `props` is what the stack's deploy tooling put on that binding.
 */
export interface Loopback {
  /** Binding name the parts read. */
  binding: string;
  /** Exported entrypoint class the binding pointed at. */
  entrypoint: string;
  /** Props the binding carried, computed from the tenant's vars. */
  props?: (env: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Every intra-tenant binding the stack deploy wires up (tyms-os scripts/deploy.mjs). A loopback is
 * only added when this script exports its entrypoint, so a tenant built without the channels part
 * simply has no CHANNELS binding, the same as a stack without a channels worker.
 */
export const TENANT_LOOPBACKS: readonly Loopback[] = [
  // The workshop reaches Context as a gatekeeper vendor. The sharing domain namespaces the
  // tenant's shared collections; stacks use `tenant-<slug>`.
  {
    binding: "GATEKEEPER_CONTEXT",
    entrypoint: "GatekeeperVendor",
    props: (env) => ({ sharingDomain: env.CONTEXT_SHARING_DOMAIN ?? env.PUBLIC_BASE_URL ?? "" }),
  },
  // Admin -> Channels, and the overseer's replies to chat platforms (named by replyBinding).
  { binding: "CHANNELS", entrypoint: "ChannelsAdmin" },
  { binding: "CHANNELS_DELIVERY", entrypoint: "ChannelsDelivery" },
  // The channels part hands inbound messages to the workshop, one binding per platform so their
  // conversations can never collide.
  ...["telegram", "slack", "email"].map((source) => ({
    binding: `WORKSHOP_${source.toUpperCase()}`,
    entrypoint: "ExternalMessageGateway",
    props: () => ({ source }),
  })),
];

/**
 * The KV bindings a Workers for Platforms tenant shares with the fleet. With `KV_PREFIX` set (the
 * uploader sets `t/<slug>/`) each is narrowed to that tenant's keys; unset, as on a stack, they are
 * the tenant's own namespaces and pass through.
 */
export const SHARED_KV_BINDINGS: readonly string[] = ["BLUEPRINTS", "AVATARS", "CONTEXT_COLLECTIONS"];

/**
 * `env` with every loopback in TENANT_LOOPBACKS this script can serve, and its shared KV narrowed
 * to the tenant. A loopback binding already present wins, so a test (or a deployment that still
 * binds a separate worker) can override one.
 */
export function withTenantEnv<E extends object>(env: E, exports: object): E {
  let vars = env as Record<string, unknown>;
  let entrypoints = exports as Record<string, unknown>;
  let added: Record<string, unknown> = {};
  let prefix = vars.KV_PREFIX;
  if (typeof prefix === "string" && prefix) {
    for (let binding of SHARED_KV_BINDINGS) {
      let kv = vars[binding];
      if (kv) added[binding] = prefixedKv(kv as KVNamespace, prefix);
    }
  }
  for (let loopback of TENANT_LOOPBACKS) {
    if (loopback.binding in env) continue;
    let entrypoint = entrypoints[loopback.entrypoint];
    if (typeof entrypoint !== "function") continue;
    added[loopback.binding] = entrypoint({ props: loopback.props?.(vars) ?? {} });
  }
  // Spread, not mutate: the runtime's env object is shared by everything in the isolate.
  return Object.keys(added).length > 0 ? { ...env, ...added } : env;
}

/**
 * `Base`, constructed with the tenant env instead of the runtime's. Durable Object and
 * WorkerEntrypoint constructors both take `(ctx, env)`, and both contexts carry `exports`.
 */
export function tenantClass<T extends TenantClass>(Base: T): T {
  let Tenant = class extends Base {
    constructor(...args: any[]) {
      let [ctx, env, ...rest] = args;
      super(ctx, withTenantEnv(env, ctx.exports), ...rest);
    }
  };
  // Logs and stack traces name the class; keep the part's name rather than the anonymous one.
  Object.defineProperty(Tenant, "name", { value: Base.name });
  return Tenant;
}

/** The parts' own default handlers. */
export interface TenantParts {
  workshop: ExportedHandler<Cloudflare.Env>;
  context: ExportedHandler<Cloudflare.Env>;
  /** The channels gatekeeper, when the tenant composes one; it is served under /channels. */
  channels?: ExportedHandler<Cloudflare.Env>;
}

/** Environment the merged handler itself reads. */
export interface TenantEnv {
  /** The workshop frontend. Absent under Workers for Platforms, where the dispatch Worker serves it. */
  ASSETS?: Fetcher;
  /** Release id reported by the readiness route. */
  RELEASE_ID?: string;
  /** This tenant's key prefix in the shared KV namespaces (see SHARED_KV_BINDINGS). */
  KV_PREFIX?: string;
}

/** Readiness route, polled by provisioning through the dispatch Worker. */
export const READY_PATH = "/.well-known/tyms/ready";

const CHANNELS_PREFIX = "/channels";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * The tenant's default handler: the router's path routing, with each part called in-process.
 *
 * - `/api*` and `/blueprint-screenshot*` go to the workshop, as the router forwarded them.
 * - `/gatekeeper/context*` goes to Context, the one router-facing gatekeeper a tenant owns (shared
 *   connectors serve their HTTP on the connectors host).
 * - `/channels/*` goes to the channels part with the prefix stripped, so its webhooks keep their
 *   paths: Telegram posts to `/channels/webhooks/telegram`.
 * - Everything else is the frontend, when this script has one.
 */
export function createTenantHandler(parts: TenantParts): ExportedHandler<Cloudflare.Env & TenantEnv> {
  return {
    async fetch(req, env, ctx) {
      let url = new URL(req.url);
      let tenantEnv = withTenantEnv(env, ctx.exports);

      if (url.pathname === READY_PATH) {
        return await ready(env, ctx);
      }

      if (isUnder(url.pathname, "/api") || isUnder(url.pathname, "/blueprint-screenshot")) {
        return await parts.workshop.fetch!(req, tenantEnv, ctx);
      }

      if (isUnder(url.pathname, "/gatekeeper/context")) {
        return await parts.context.fetch!(req, tenantEnv, ctx);
      }

      if (parts.channels && isUnder(url.pathname, CHANNELS_PREFIX)) {
        let inner = new URL(url);
        inner.pathname = url.pathname.slice(CHANNELS_PREFIX.length) || "/";
        return await parts.channels.fetch!(new Request(inner, req), tenantEnv, ctx);
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(req);
      }
      return new Response("Not Found", { status: 404 });
    },
  };
}

// The AdminSettings surface the readiness route uses. The class itself is typed in its own package.
interface ReadinessTarget {
  ensureCentralSettingsSync(): Promise<void>;
}

/**
 * Ready once the workshop's AdminSettings Durable Object answers. The call also starts the central
 * settings pull, which the stack deploy started with its first `GET /api`.
 */
async function ready(env: TenantEnv, ctx: ExecutionContext): Promise<Response> {
  let headers = { "Cache-Control": "no-store" };
  let adminSettings = (ctx.exports as unknown as Record<string, DurableObjectNamespace>).AdminSettings;
  try {
    let stub = adminSettings.getByName("") as unknown as ReadinessTarget;
    await stub.ensureCentralSettingsSync();
  } catch (error) {
    return Response.json({ ready: false, error: String(error) }, { status: 503, headers });
  }
  return Response.json({ ready: true, release: env.RELEASE_ID ?? null }, { headers });
}
