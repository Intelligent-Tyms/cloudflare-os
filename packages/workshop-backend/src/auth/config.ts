// Configuration for sign-in via authentication gatekeepers (an optional, additive login feature).
//
// Authentication is provided by gatekeepers (e.g. "google", "github", "cloudflare") that advertise
// `providesAuth`. A deployment opts specific gatekeepers into the login UI via the AUTH_GATEKEEPERS
// allowlist (comma-separated vendor ids). When set, each listed, auth-capable gatekeeper gets a
// "Continue with ..." button alongside the normal username/password form (unless password auth is
// disabled). All OFF by default.

/**
 * Parse the AUTH_GATEKEEPERS allowlist into a list of gatekeeper vendor ids (lowercased). These are
 * the gatekeepers permitted to drive sign-in; a vendor must also actually advertise `providesAuth`
 * to be offered. Empty when unset.
 */
export function getAuthGatekeeperAllowlist(env: Cloudflare.Env): string[] {
  const raw = (env as { AUTH_GATEKEEPERS?: string }).AUTH_GATEKEEPERS;
  if (!raw) return [];
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Whether the deployment has opted any gatekeeper into sign-in. */
export function hasAuthGatekeepers(env: Cloudflare.Env): boolean {
  return getAuthGatekeeperAllowlist(env).length > 0;
}

/**
 * Whether the deployment delegates sign-in to a central identity service (multi-tenant
 * installations). When set, the login page offers/redirects to CENTRAL_LOGIN_URL and completes
 * sign-in via a handoff token (PublicApi.loginWithHandoffToken).
 */
export function hasCentralLogin(env: Cloudflare.Env): boolean {
  const e = env as { CENTRAL_LOGIN_URL?: string; HANDOFF_PUBLIC_KEY?: string };
  return Boolean(e.CENTRAL_LOGIN_URL && e.HANDOFF_PUBLIC_KEY);
}

/**
 * Whether username/password login + signup is available. Enabled by default. An installation can
 * set DISABLE_PASSWORD_AUTH=true to be OAuth-only — but that only takes effect when some other way
 * to sign in exists (an allowlisted auth gatekeeper, or central login), otherwise we'd lock
 * everyone out, so password auth stays on.
 */
export function isPasswordAuthEnabled(env: Cloudflare.Env): boolean {
  if (env.DISABLE_PASSWORD_AUTH !== "true") return true;
  return !hasAuthGatekeepers(env) && !hasCentralLogin(env);
}
