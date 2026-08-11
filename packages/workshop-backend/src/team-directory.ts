// Client for the central team directory (membership + invitations) on deployments that have
// one (CENTRAL_TEAM_API_URL / CENTRAL_TEAM_API_TOKEN, injected by the deploy service). The
// workshop keeps no member list of its own: Admin → Teammates proxies to this API, and the
// directory enforces the real access control (only members receive sign-in handoffs).

import { TeamView } from "@gadgets/workshop-shared/api";

/** Whether this deployment has a central team directory configured. */
export function hasTeamDirectory(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
}

// The directory returns {team} on success and {error} otherwise; errors are written for end
// users (e.g. "that person is already a member"), so they surface as-is in the admin UI.
async function call(env: Cloudflare.Env, path: string, body?: object): Promise<TeamView> {
  let response = await fetch(`${env.CENTRAL_TEAM_API_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${env.CENTRAL_TEAM_API_TOKEN}`,
      ...(body === undefined ? {} : {"content-type": "application/json"}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = (await response.json().catch(() => ({}))) as {team?: TeamView; error?: string};
  if (!response.ok || !data.team) {
    throw new Error(data.error ?? `The team directory is unavailable (${response.status}).`);
  }
  return data.team;
}

/** Current members and pending invitations. */
export function fetchTeam(env: Cloudflare.Env): Promise<TeamView> {
  return call(env, "/team");
}

/** Create an invitation; the directory sends the invitation email. */
export function createTeamInvitation(
    env: Cloudflare.Env, email: string, role: string, invitedBy: string): Promise<TeamView> {
  return call(env, "/team/invitations", {email, role, invitedBy});
}

/** Revoke a pending invitation. */
export function revokeTeamInvitation(env: Cloudflare.Env, invitationId: string): Promise<TeamView> {
  return call(env, `/team/invitations/${encodeURIComponent(invitationId)}/revoke`, {});
}

/** Re-send a pending invitation with a fresh link and expiry. */
export function resendTeamInvitation(env: Cloudflare.Env, invitationId: string): Promise<TeamView> {
  return call(env, `/team/invitations/${encodeURIComponent(invitationId)}/resend`, {});
}

/** Remove a member. The directory refuses to remove the owner or the actor themselves. */
export function removeTeamMember(env: Cloudflare.Env, email: string, actor: string): Promise<TeamView> {
  return call(env, "/team/members/remove", {email, actor});
}
