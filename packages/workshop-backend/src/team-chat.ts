// Team chat: human-to-human messaging between the members of one deployment, backed by
// Stream Chat (getstream.io). The platform owns a single Stream app shared by the whole fleet;
// isolation between deployments is Stream's multi-tenant mode: every user carries this
// deployment's tenant slug as their one `team`, every channel is created with that `team`,
// and Stream then refuses cross-team reads and writes. The browser only ever holds a user
// token; user upserts and channel creation happen here with the server secret so the team
// and membership of everything are set by the deployment, never by the client.

import { SignJWT } from "jose";
import { TeamChatSession, TeamChatTeammate } from "@gadgets/workshop-shared/api";
import { fetchTeam, hasTeamDirectory } from "./team-directory.js";

const STREAM_API_URL = "https://chat.stream-io-api.com";
const USER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Stream user ids: at most 64 chars of [a-z0-9@_-].
const MAX_STREAM_ID_LENGTH = 64;

type StreamEnv = Cloudflare.Env;

/** Whether this deployment can offer team chat. */
export function hasTeamChat(env: StreamEnv): boolean {
  return Boolean(env.STREAM_API_KEY && env.STREAM_API_SECRET && teamOf(env) &&
      hasTeamDirectory(env));
}

// The Stream team is the tenant slug. The deploy tooling already sets it for gateway log
// attribution on every fleet tenant; a deployment without one has no team chat.
function teamOf(env: StreamEnv): string | undefined {
  return env.CF_AI_GATEWAY_TENANT?.trim() || undefined;
}

/** Deterministic Stream user id for a member email within a team. */
export async function streamUserId(team: string, email: string): Promise<string> {
  let local = email.trim().toLowerCase().replace(/[^a-z0-9@_-]/g, "_");
  let id = `${team}--${local}`;
  if (id.length <= MAX_STREAM_ID_LENGTH) return id;
  // Too long for Stream: fall back to a hash of the email, still prefixed by the team so ids
  // never collide across deployments.
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  let hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${team}--h-${hex.slice(0, 32)}`;
}

function displayName(email: string, name: string | null | undefined): string {
  let trimmed = name?.trim();
  return trimmed || email.split("@")[0];
}

class StreamClient {
  constructor(private apiKey: string, private secret: Uint8Array) {}

  static from(env: StreamEnv): StreamClient | null {
    if (!env.STREAM_API_KEY || !env.STREAM_API_SECRET) return null;
    return new StreamClient(env.STREAM_API_KEY, new TextEncoder().encode(env.STREAM_API_SECRET));
  }

  #serverToken(): Promise<string> {
    return new SignJWT({ server: true }).setProtectedHeader({ alg: "HS256" }).sign(this.secret);
  }

  userToken(userId: string, expiresAt: number): Promise<string> {
    return new SignJWT({ user_id: userId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(this.secret);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let url = new URL(path, STREAM_API_URL);
    url.searchParams.set("api_key", this.apiKey);
    let response = await fetch(url, {
      method,
      headers: {
        authorization: await this.#serverToken(),
        "stream-auth-type": "jwt",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error(`Stream Chat request failed (${response.status}): ${data.message ?? "unknown error"}`);
    }
    return data;
  }

  /** Upsert users, pinning each to exactly one team. */
  async upsertUsers(users: { id: string; name: string; team: string }[]): Promise<void> {
    if (users.length === 0) return;
    let payload: Record<string, { id: string; name: string; teams: string[] }> = {};
    for (let user of users) {
      payload[user.id] = { id: user.id, name: user.name, teams: [user.team] };
    }
    await this.call("POST", "/users", { users: payload });
  }
}

export class TeamChat {
  private constructor(private env: StreamEnv, private client: StreamClient, readonly team: string) {}

  static from(env: StreamEnv): TeamChat | null {
    let client = StreamClient.from(env);
    let team = teamOf(env);
    if (!client || !team || !hasTeamDirectory(env)) return null;
    return new TeamChat(env, client, team);
  }

  /** Upsert the caller on Stream and mint their user token. */
  async session(email: string): Promise<TeamChatSession> {
    let userId = await streamUserId(this.team, email);
    let name = await this.#nameOf(email);
    await this.client.upsertUsers([{ id: userId, name, team: this.team }]);
    let expiresAt = Date.now() + USER_TOKEN_TTL_MS;
    let token = await this.client.userToken(userId, expiresAt);
    return { apiKey: this.env.STREAM_API_KEY!, userId, name, team: this.team, token, expiresAt };
  }

  /** Everyone in the team directory except the caller, upserted on Stream. */
  async teammates(callerEmail: string): Promise<TeamChatTeammate[]> {
    let team = await fetchTeam(this.env);
    let caller = callerEmail.toLowerCase();
    let result: TeamChatTeammate[] = [];
    for (let member of team.members) {
      if (member.email.toLowerCase() === caller) continue;
      result.push({
        streamId: await streamUserId(this.team, member.email),
        email: member.email,
        name: displayName(member.email, member.displayName),
      });
    }
    await this.client.upsertUsers(result.map(t => ({ id: t.streamId, name: t.name, team: this.team })));
    return result.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create a channel for the caller. One member and no name = the distinct DM between the
   * two (Stream dedupes distinct channels by member set); otherwise a named group with a
   * fresh id. Member ids are checked against the team directory so a caller can only ever
   * pull their own teammates into a channel.
   */
  async createChannel(callerEmail: string, memberIds: string[], name?: string): Promise<{ cid: string }> {
    let callerId = await streamUserId(this.team, callerEmail);
    let allowed = new Set((await this.teammates(callerEmail)).map(t => t.streamId));
    let members = [...new Set(memberIds)].filter(id => id !== callerId);
    if (members.length === 0) throw new Error("Pick at least one teammate.");
    for (let id of members) {
      if (!allowed.has(id)) throw new Error("You can only message members of this team.");
    }
    let trimmedName = name?.trim();
    let isDm = members.length === 1 && !trimmedName;
    let data: Record<string, unknown> = {
      members: [callerId, ...members],
      team: this.team,
      created_by_id: callerId,
    };
    let path;
    if (isDm) {
      path = "/channels/messaging/query";
    } else {
      if (!trimmedName) throw new Error("Give the group a name.");
      if (trimmedName.length > 80) throw new Error("Group names are limited to 80 characters.");
      data.name = trimmedName;
      path = `/channels/messaging/${crypto.randomUUID().replace(/-/g, "")}/query`;
    }
    let response = await this.client.call<{ channel: { cid: string } }>("POST", path, {
      data, state: false, presence: false, watch: false,
    });
    return { cid: response.channel.cid };
  }

  async #nameOf(email: string): Promise<string> {
    try {
      let team = await fetchTeam(this.env);
      let member = team.members.find(m => m.email.toLowerCase() === email.toLowerCase());
      return displayName(email, member?.displayName);
    } catch {
      return displayName(email, null);
    }
  }
}
