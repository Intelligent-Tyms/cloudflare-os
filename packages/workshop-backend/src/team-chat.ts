// Team chat: human-to-human messaging between the members of one deployment, backed by
// Stream Chat (getstream.io). The platform owns a single Stream app shared by the whole fleet;
// isolation between deployments is Stream's multi-tenant mode: every user carries this
// deployment's tenant slug as their one `team`, every channel is created with that `team`,
// and Stream then refuses cross-team reads and writes. The browser only ever holds a user
// token; user upserts and channel creation happen here with the server secret so the team
// and membership of everything are set by the deployment, never by the client.

import { SignJWT } from "jose";
import { TeamChatSession, TeamChatTeammate, TeamChatChannelChanges } from "@gadgets/workshop-shared/api";
import { fetchTeam, hasTeamDirectory } from "./team-directory.js";
import { isPoolMode } from "./pool-mode.js";

const STREAM_API_URL = "https://chat.stream-io-api.com";
const USER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Stream user ids: at most 64 chars of [a-z0-9@_-].
const MAX_STREAM_ID_LENGTH = 64;

type StreamEnv = Cloudflare.Env;

/** Unread messages to email someone who is away. */
export type UnreadDigest = {
  cid: string;
  title: string;
  isGroup: boolean;
  messages: { from: string; text: string; at: number }[];
};

/** Whether this deployment can offer team chat. */
export function hasTeamChat(env: StreamEnv): boolean {
  // A pool's members are strangers to each other: no team, no chat (the deploy tooling also
  // withholds the Stream credentials there; this guard makes the rule hold regardless).
  if (isPoolMode(env)) return false;
  return Boolean(env.STREAM_API_KEY && env.STREAM_API_SECRET && teamOf(env) &&
      hasTeamDirectory(env));
}

// The Stream team is the tenant slug. The deploy tooling already sets it for gateway log
// attribution on every fleet tenant; a deployment without one has no team chat.
function teamOf(env: StreamEnv): string | undefined {
  return env.CF_AI_GATEWAY_TENANT?.trim() || undefined;
}

/** Deterministic Stream user id for a member email within a team. */
/**
 * The Stream channel id inside a Discuss cid, or null when it is not one of ours. Groups get
 * a hex id from createChannel; DMs are Stream "distinct" channels, whose ids Stream generates
 * as "!members-<hash>" — the leading "!" is part of the id.
 */
function conversationId(cid: string): string | null {
  let [type, id] = cid.split(":");
  if (type !== "messaging" || !id || !/^!?[a-z0-9_-]+$/i.test(id)) return null;
  return id;
}

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
    if (!hasTeamChat(env)) return null;
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

  /**
   * Rename a group and/or change its members. The caller must be a member of the channel and
   * the channel must be a group (have a name) in this team; DMs are immutable. Added members
   * are checked against the team directory like createChannel(). Member changes post a system
   * message so the conversation shows who did what.
   */
  async updateChannel(callerEmail: string, cid: string, changes: TeamChatChannelChanges): Promise<void> {
    let { callerId, id, channel } = await this.#groupForMember(callerEmail, cid);
    let name = changes.name?.trim();
    if (changes.name !== undefined) {
      if (!name) throw new Error("Give the group a name.");
      if (name.length > 80) throw new Error("Group names are limited to 80 characters.");
      if (name !== channel.name) {
        await this.client.call("PATCH", `/channels/messaging/${id}`, { set: { name } });
      }
    }
    let add = [...new Set(changes.addMembers ?? [])].filter(m => !channel.memberIds.has(m));
    let remove = [...new Set(changes.removeMembers ?? [])].filter(m => channel.memberIds.has(m));
    if (add.length === 0 && remove.length === 0) return;
    let teammates = await this.teammates(callerEmail);
    let byId = new Map(teammates.map(t => [t.streamId, t]));
    for (let m of add) {
      if (!byId.has(m)) throw new Error("You can only add members of this team.");
    }
    if (remove.includes(callerId)) throw new Error("Use leave to remove yourself.");
    let callerName = await this.#nameOf(callerEmail);
    let nameOf = (m: string) => byId.get(m)?.name ?? "a teammate";
    let parts: string[] = [];
    if (add.length) parts.push(`${callerName} added ${add.map(nameOf).join(", ")}`);
    if (remove.length) parts.push(`${callerName} removed ${remove.map(nameOf).join(", ")}`);
    let body: Record<string, unknown> = {
      message: { type: "system", text: parts.join(". "), user_id: callerId },
    };
    if (add.length) body.add_members = add;
    if (remove.length) body.remove_members = remove;
    await this.client.call("POST", `/channels/messaging/${id}`, body);
  }

  /**
   * Who should be nudged by email if they do not read `messageId` soon: the other person of
   * a DM, or the @mentioned members of a group (groups are chatty; unmentioned members are
   * not emailed). Returns their emails. The message must be the caller's own.
   */
  async recipientsToNudge(callerEmail: string, cid: string, messageId: string): Promise<string[]> {
    let skip = (reason: string, extra: Record<string, unknown> = {}) => {
      console.log(JSON.stringify({ event: "discuss_nudge_skip", reason, cid, ...extra }));
      return [] as string[];
    };
    let id = conversationId(cid);
    if (!id) return skip("bad_cid");
    if (!/^[a-z0-9_-]+$/i.test(messageId)) return skip("bad_message_id", { messageId });
    let callerId = await streamUserId(this.team, callerEmail);
    let { message } = await this.client.call<{
      message: { cid: string; user?: { id: string }; mentioned_users?: { id: string }[]; type?: string };
    }>("GET", `/messages/${encodeURIComponent(messageId)}`);
    if (message.cid !== cid) return skip("cid_mismatch", { messageCid: message.cid });
    if (message.user?.id !== callerId) return skip("not_caller", { sender: message.user?.id, callerId });
    if (message.type === "system" || message.type === "deleted") return skip("message_type", { type: message.type });
    let channel = await this.client.call<{
      channel: { team?: string; name?: string };
      members: { user_id?: string }[];
    }>("POST", `/channels/messaging/${encodeURIComponent(id)}/query`, { state: true, watch: false, presence: false });
    if (channel.channel.team !== this.team) return skip("wrong_team", { channelTeam: channel.channel.team });
    let memberIds = new Set(channel.members.map(m => m.user_id).filter((m): m is string => Boolean(m)));
    memberIds.delete(callerId);
    let targets: string[];
    if (channel.channel.name) {
      targets = (message.mentioned_users ?? []).map(u => u.id).filter(u => memberIds.has(u));
    } else {
      targets = [...memberIds];
    }
    if (targets.length === 0) return skip("no_targets", { group: Boolean(channel.channel.name), members: memberIds.size });
    let team = await fetchTeam(this.env);
    let emails: string[] = [];
    for (let member of team.members) {
      let sid = await streamUserId(this.team, member.email);
      if (targets.includes(sid)) emails.push(member.email);
    }
    if (emails.length === 0) return skip("targets_not_in_directory", { targets });
    console.log(JSON.stringify({ event: "discuss_nudge_recipients", cid, recipients: emails.length }));
    return emails;
  }

  /**
   * What `recipientEmail` has not read in `cid`, if they are away: null when there is
   * nothing to email (all read, they are online, the conversation is muted, or the channel is
   * gone); otherwise the unread messages from others, newest last, capped.
   */
  async unreadDigest(recipientEmail: string, cid: string): Promise<UnreadDigest | null> {
    let skip = (reason: string, extra: Record<string, unknown> = {}) => {
      console.log(JSON.stringify({ event: "discuss_digest_skip", reason, cid, ...extra }));
      return null;
    };
    let id = conversationId(cid);
    if (!id) return skip("bad_cid");
    let recipientId = await streamUserId(this.team, recipientEmail);
    let response = await this.client.call<{
      channel: { team?: string; name?: string };
      members: { user_id?: string; user?: { id: string; name?: string; online?: boolean } }[];
      messages: { id: string; type?: string; text?: string; created_at: string; user?: { id: string; name?: string };
        attachments?: unknown[] }[];
      read?: { user: { id: string }; last_read: string; unread_messages?: number }[];
    }>("POST", `/channels/messaging/${encodeURIComponent(id)}/query`, {
      state: true, watch: false, presence: false, messages: { limit: 30 },
    });
    if (response.channel.team !== this.team) return skip("wrong_team");
    let me = response.members.find(m => m.user_id === recipientId);
    if (!me) return skip("not_member");
    if (me.user?.online) return skip("online");
    let read = response.read?.find(r => r.user.id === recipientId);
    if (read && (read.unread_messages ?? 0) === 0) return skip("all_read", { lastRead: read.last_read });
    let lastRead = read ? Date.parse(read.last_read) : 0;
    let unread = response.messages
      .filter(m => m.user?.id !== recipientId && m.type !== "deleted" && m.type !== "system"
          && Date.parse(m.created_at) > lastRead)
      .map(m => ({
        from: m.user?.name || "A teammate",
        text: (m.text?.trim() || (m.attachments?.length ? "Sent an attachment" : "")).slice(0, 500),
        at: Date.parse(m.created_at),
      }))
      .filter(m => m.text);
    if (unread.length === 0) return skip("nothing_unread_from_others", { lastRead, fetched: response.messages.length });
    if (await this.#isMuted(recipientId, cid)) return skip("muted");
    let others = response.members.filter(m => m.user_id !== recipientId);
    let title = response.channel.name
        || others.map(m => m.user?.name || "Teammate").join(", ")
        || "Discuss";
    console.log(JSON.stringify({ event: "discuss_digest", cid, unread: unread.length }));
    return { cid, title, isGroup: Boolean(response.channel.name), messages: unread.slice(-10) };
  }

  /** Email the digest through the central directory (which builds the tenant link). */
  async emailUnread(recipientEmail: string, digest: UnreadDigest): Promise<boolean> {
    if (!this.env.CENTRAL_TEAM_API_URL || !this.env.CENTRAL_TEAM_API_TOKEN) return false;
    let response = await fetch(`${this.env.CENTRAL_TEAM_API_URL}/notifications/discuss-unread`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.CENTRAL_TEAM_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recipientEmail, ...digest }),
    });
    let data = (await response.json().catch(() => ({}))) as { notified?: boolean };
    if (!response.ok) {
      console.warn(`discuss unread email failed (${response.status})`);
      return false;
    }
    return data.notified === true;
  }

  // Whether the recipient has muted the conversation (best-effort: an error counts as "no").
  async #isMuted(recipientId: string, cid: string): Promise<boolean> {
    try {
      let result = await this.client.call<{ channels: unknown[] }>("POST", "/channels", {
        filter_conditions: { cid: { $eq: cid }, muted: true },
        user_id: recipientId,
        state: false, watch: false, presence: false,
      });
      return result.channels.length > 0;
    } catch (err) {
      console.warn("mute check failed:", err);
      return false;
    }
  }

  /** Remove the caller from a group they belong to. */
  async leaveChannel(callerEmail: string, cid: string): Promise<void> {
    let { callerId, id } = await this.#groupForMember(callerEmail, cid);
    let callerName = await this.#nameOf(callerEmail);
    await this.client.call("POST", `/channels/messaging/${id}`, {
      remove_members: [callerId],
      message: { type: "system", text: `${callerName} left`, user_id: callerId },
    });
  }

  // Load a channel and check it is a group in this team that the caller belongs to.
  async #groupForMember(callerEmail: string, cid: string): Promise<{
    callerId: string;
    id: string;
    channel: { name: string | undefined; memberIds: Set<string> };
  }> {
    let [type, id] = cid.split(":");
    if (type !== "messaging" || !id || !/^[a-z0-9_-]+$/i.test(id)) {
      throw new Error("Unknown conversation.");
    }
    let callerId = await streamUserId(this.team, callerEmail);
    let response = await this.client.call<{
      channel: { team?: string; name?: string };
      members: { user_id?: string }[];
    }>("POST", `/channels/messaging/${id}/query`, { state: true, watch: false, presence: false });
    let memberIds = new Set(response.members.map(m => m.user_id).filter((m): m is string => Boolean(m)));
    if (response.channel.team !== this.team || !memberIds.has(callerId)) {
      throw new Error("You are not a member of this conversation.");
    }
    if (!response.channel.name) throw new Error("Direct messages can't be changed.");
    return { callerId, id, channel: { name: response.channel.name, memberIds } };
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
