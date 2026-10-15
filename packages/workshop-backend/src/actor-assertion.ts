// Per-person identity for an agent's calls to the organization wiki.
//
// The Intelligence gatekeeper calls the wiki with a tenant-wide assistant key, which says which
// workspace is calling but not who. When a person's turn opens a wiki session, the Workshop hands
// the gatekeeper a provider that mints a short-lived assertion of that person from the control
// plane (signed with the fleet key; the cell verifies it and records the person as the actor,
// never granting more than the lower of the key's scope and the person's own wiki role). Minting
// goes through the tenant API like the team and billing directories do.

import { RpcTarget } from "capnweb";
import type { ActorAssertionProvider } from "@gadgets/workshop-shared/gatekeeper";

export type ActorRole = "owner" | "admin" | "member";

export type ActorAssertion = { token: string; expiresAt: number };

/** Re-mint this long before expiry, so a call made with a cached token lands before it lapses. */
export const ACTOR_ASSERTION_REFRESH_MARGIN_MS = 60_000;

export function hasActorAssertions(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
}

/**
 * Mints an assertion for `email`, or null when this deployment has no central directory or the
 * workspace has no active wiki (the control plane answers 404 `not_provisioned`). Any other
 * failure throws with the control plane's message.
 */
export async function mintActorAssertion(
    env: Cloudflare.Env, actor: { email: string; role: ActorRole }): Promise<ActorAssertion | null> {
  if (!hasActorAssertions(env)) return null;
  let response = await fetch(`${env.CENTRAL_TEAM_API_URL}/intelligence/actor`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CENTRAL_TEAM_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: actor.email, role: actor.role }),
  });
  let data = (await response.json().catch(() => ({}))) as
      Partial<ActorAssertion> & { error?: string };
  if (response.status === 404) return null;
  if (!response.ok || typeof data.token !== "string" || typeof data.expiresAt !== "number") {
    throw new Error(data.error ?? `The intelligence directory is unavailable (${response.status}).`);
  }
  return { token: data.token, expiresAt: data.expiresAt };
}

/**
 * Whether `email` is on the deploy-time ADMINS list. The central role (owner/admin from the
 * handoff) is authoritative on the control plane anyway; this only shapes the claim we send.
 */
export function isDeployAdmin(env: Cloudflare.Env, email: string): boolean {
  let admins: unknown = env.ADMINS;
  if (!admins) return false;
  if (typeof admins === "string") {
    try {
      admins = JSON.parse(admins);
    } catch {
      return false;
    }
  }
  return Array.isArray(admins) && admins.includes(email);
}

// One cache per isolate: a tenant worker serves one workspace, and assertions are scoped to it.
// Keyed by email; an entry is reused until shortly before it expires.
const cache = new Map<string, ActorAssertion>();

/** Test hook: forget every cached assertion. */
export function resetActorAssertionCache(): void {
  cache.clear();
}

/** The provider handed to a gatekeeper's `startSession` for one person. */
export class ActorAssertionImpl extends RpcTarget implements ActorAssertionProvider {
  constructor(private env: Cloudflare.Env, private email: string,
              private now: () => number = Date.now) {
    super();
  }

  async mint(): Promise<ActorAssertion | null> {
    let cached = cache.get(this.email);
    if (cached && cached.expiresAt - ACTOR_ASSERTION_REFRESH_MARGIN_MS > this.now()) return cached;
    let minted = await mintActorAssertion(this.env, {
      email: this.email,
      role: isDeployAdmin(this.env, this.email) ? "admin" : "member",
    });
    if (minted) cache.set(this.email, minted);
    else cache.delete(this.email);
    return minted;
  }
}
