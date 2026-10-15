// Admin calls from the control plane: a workspace's owners and admins manage it on the
// central admin portal, which asks this deployment to run an AdminApi method on their behalf.
// Server to server, like the sign-out fan-out (/api/central/signout): the control plane POSTs
// a JWT signed with the central handoff key, and this verifies it with HANDOFF_PUBLIC_KEY,
// so nothing is trusted here that a handoff isn't already trusted with (a handoff can make
// anyone an admin through its role claim).
//
// The token carries the whole call: `purpose: "admin"`, the acting admin (`sub`, their email),
// the method and its arguments. Signing the arguments means a captured token cannot be turned
// into a different call; its 60-second lifetime bounds a replay to the same call. The control
// plane checks the actor's role; this checks the method against CENTRAL_ADMIN_METHODS, so the
// portal reaches only what was moved there, never the whole AdminApi.

import { importSPKI, jwtVerify } from "jose";
import { hasCentralLogin } from "./auth/config.js";
import { AdminApiImpl } from "./admin-settings.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.central.admin");

/** Where the control plane sends admin calls. */
export const CENTRAL_ADMIN_PATH = "/api/central/admin";

/** The AdminApi methods the admin portal may call, each with how many arguments it takes. */
export const CENTRAL_ADMIN_METHODS = {
  getIntelligenceOverview: 0,
  provisionIntelligence: 1,
  deprovisionIntelligence: 1,
  reconnectIntelligence: 1,
  // Messaging channels: the channels worker is per tenant, reachable only from here.
  getChannels: 0,
  setupTelegram: 1,
  clearTelegramSetup: 0,
  setupEmail: 2,
  clearEmailSetup: 0,
  mintTelegramLinkCode: 1,
  listTelegramBindings: 0,
  unlinkTelegram: 1,
  provisionEmailInbox: 2,
  listEmailInboxes: 0,
  deleteEmailInbox: 1,
} as const satisfies Partial<Record<keyof AdminApiImpl, number>>;

export type CentralAdminMethod = keyof typeof CENTRAL_ADMIN_METHODS;

export function isCentralAdminMethod(value: unknown): value is CentralAdminMethod {
  return typeof value === "string" && Object.hasOwn(CENTRAL_ADMIN_METHODS, value);
}

/** A verified call: who asked, and what to run. */
export type CentralAdminCall = { actor: string; method: CentralAdminMethod; args: unknown[] };

/** Check a token's claims (after the signature): an admin call naming an allowed method. */
export function parseCentralAdminClaims(payload: Record<string, unknown>): CentralAdminCall | null {
  if (payload.purpose !== "admin") return null;
  if (typeof payload.sub !== "string" || !payload.sub.includes("@")) return null;
  if (!isCentralAdminMethod(payload.method)) return null;
  let args = payload.args === undefined ? [] : payload.args;
  if (!Array.isArray(args) || args.length > CENTRAL_ADMIN_METHODS[payload.method]) return null;
  return { actor: payload.sub.toLowerCase(), method: payload.method, args };
}

export async function handleCentralAdmin(
    req: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!hasCentralLogin(env)) {
    return Response.json({ error: "central login is not enabled" }, { status: 404 });
  }
  let body = await req.json().catch(() => ({})) as { token?: unknown };
  if (typeof body.token !== "string") return Response.json({ error: "token required" }, { status: 400 });

  let key = await importSPKI(
      `-----BEGIN PUBLIC KEY-----\n${env.HANDOFF_PUBLIC_KEY}\n-----END PUBLIC KEY-----`, "EdDSA");
  let call: CentralAdminCall | null = null;
  try {
    let { payload } = await jwtVerify(body.token, key, { audience: env.HANDOFF_AUDIENCE, clockTolerance: 5 });
    call = parseCentralAdminClaims(payload);
  } catch {
    // Falls through to the refusal below.
  }
  if (!call) return Response.json({ error: "invalid token" }, { status: 403 });

  let api = new AdminApiImpl(ctx.exports.AdminSettings.getByName(""), call.actor, env);
  try {
    let fn = api[call.method] as (...args: unknown[]) => Promise<unknown>;
    let result = await fn.apply(api, call.args);
    logger.info("central admin call", { event: "central_admin.call", operation: call.method, outcome: "ok" });
    return Response.json({ result: result ?? null });
  } catch (error) {
    // AdminApi refusals are written for the admin ("...is not provisioned..."), so they go back as-is.
    logger.warn("central admin call failed", { event: "central_admin.call", operation: call.method, outcome: "error", error });
    return Response.json({ error: error instanceof Error ? error.message : "the call failed" }, { status: 400 });
  }
}
