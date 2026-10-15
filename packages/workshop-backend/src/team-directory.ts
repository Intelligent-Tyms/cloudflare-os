// Client for the central team directory (membership + invitations) on deployments that have
// one (CENTRAL_TEAM_API_URL / CENTRAL_TEAM_API_TOKEN, injected by the deploy service). The
// workshop keeps no member list of its own: membership is managed in the admin portal, and the
// directory enforces the real access control (only members receive sign-in handoffs). The
// workshop only reads it (team chat's member list).

import { TeamView } from "@gadgets/workshop-shared/api";

/** Whether this deployment has a central team directory configured. */
export function hasTeamDirectory(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
}

// The directory returns {team} on success and {error} otherwise.
async function call(env: Cloudflare.Env, path: string): Promise<TeamView> {
  let response = await fetch(`${env.CENTRAL_TEAM_API_URL}${path}`, {
    headers: {authorization: `Bearer ${env.CENTRAL_TEAM_API_TOKEN}`},
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
