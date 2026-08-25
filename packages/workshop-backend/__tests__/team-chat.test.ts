import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { TeamChat, hasTeamChat, streamUserId } from "../src/team-chat";

const configured = {
  STREAM_API_KEY: "key",
  STREAM_API_SECRET: "secret",
  CF_AI_GATEWAY_TENANT: "acme-co",
  CENTRAL_TEAM_API_URL: "https://start.example.com/tenant-api",
  CENTRAL_TEAM_API_TOKEN: "acme-co:token",
} as unknown as Cloudflare.Env;

describe("team chat", () => {
  it("derives stable, Stream-legal user ids prefixed by the team", async () => {
    const id = await streamUserId("acme-co", "Jane.Doe@Example.com");
    expect(id).toBe("acme-co--jane_doe@example_com");
    expect(id).toMatch(/^[a-z0-9@_-]+$/);
    expect(await streamUserId("acme-co", "jane.doe@example.com")).toBe(id);
    expect(await streamUserId("other", "jane.doe@example.com")).not.toBe(id);
  });

  it("hashes ids that would exceed Stream's 64-character limit", async () => {
    const email = "a-very-long-mailbox-name-that-goes-on-and-on@subdomain.example-company.com";
    const id = await streamUserId("acme-co", email);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.startsWith("acme-co--h-")).toBe(true);
    expect(await streamUserId("acme-co", email)).toBe(id);
  });

  it("is off unless key, secret, tenant slug and team directory are all present", () => {
    expect(hasTeamChat(configured)).toBe(true);
    expect(TeamChat.from(configured)?.team).toBe("acme-co");
    for (const missing of ["STREAM_API_KEY", "STREAM_API_SECRET", "CF_AI_GATEWAY_TENANT",
        "CENTRAL_TEAM_API_TOKEN"]) {
      const env = { ...configured, [missing]: undefined } as unknown as Cloudflare.Env;
      expect(hasTeamChat(env), missing).toBe(false);
      expect(TeamChat.from(env), missing).toBeNull();
    }
  });

  it("mints an expiring HS256 user token and upserts the caller with its team", async () => {
    const calls: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/team")) {
        return Response.json({ team: { members: [
          { email: "jane@example.com", displayName: "Jane Doe", role: "member", createdAt: 0 },
        ], invitations: [] } });
      }
      return Response.json({});
    }) as typeof fetch;
    try {
      const session = await TeamChat.from(configured)!.session("jane@example.com");
      expect(session.userId).toBe("acme-co--jane@example_com");
      expect(session.name).toBe("Jane Doe");
      expect(session.team).toBe("acme-co");
      const { payload } = await jwtVerify(session.token, new TextEncoder().encode("secret"),
          { algorithms: ["HS256"] });
      expect(payload.user_id).toBe(session.userId);
      expect(payload.exp! * 1000).toBeGreaterThan(Date.now());
      const upsert = calls.find(c => c.url.includes("/users?"));
      expect(upsert?.body.users[session.userId].teams).toEqual(["acme-co"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  function fakeStream(channel: { team?: string; name?: string; members: string[] }) {
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/team")) {
        return Response.json({ team: { members: [
          { email: "jane@example.com", displayName: "Jane Doe", role: "member", createdAt: 0 },
          { email: "bob@example.com", displayName: "Bob", role: "member", createdAt: 0 },
          { email: "eve@example.com", displayName: "Eve", role: "member", createdAt: 0 },
        ], invitations: [] } });
      }
      if (url.includes("/query?")) {
        return Response.json({
          channel: { team: channel.team ?? "acme-co", name: channel.name },
          members: channel.members.map(user_id => ({ user_id })),
        });
      }
      return Response.json({});
    }) as typeof fetch;
    return calls;
  }

  it("renames a group and adds/removes members with a system message", async () => {
    const realFetch = globalThis.fetch;
    const calls = fakeStream({ name: "Launch", members: ["acme-co--jane@example_com", "acme-co--bob@example_com"] });
    try {
      await TeamChat.from(configured)!.updateChannel("jane@example.com", "messaging:abc", {
        name: "Launch v2",
        addMembers: ["acme-co--eve@example_com"],
        removeMembers: ["acme-co--bob@example_com"],
      });
      const rename = calls.find(c => c.method === "PATCH");
      expect(rename?.url).toContain("/channels/messaging/abc?");
      expect(rename?.body).toEqual({ set: { name: "Launch v2" } });
      const members = calls.find(c => c.method === "POST" && c.url.includes("/channels/messaging/abc?"));
      expect(members?.body.add_members).toEqual(["acme-co--eve@example_com"]);
      expect(members?.body.remove_members).toEqual(["acme-co--bob@example_com"]);
      expect(members?.body.message.type).toBe("system");
      expect(members?.body.message.text).toBe("Jane Doe added Eve. Jane Doe removed Bob");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses to change DMs, other teams' channels, or channels the caller is not in", async () => {
    const realFetch = globalThis.fetch;
    try {
      fakeStream({ members: ["acme-co--jane@example_com", "acme-co--bob@example_com"] });
      await expect(TeamChat.from(configured)!.updateChannel("jane@example.com", "messaging:dm", { name: "x" }))
        .rejects.toThrow(/Direct messages/);
      fakeStream({ name: "Other", team: "other-co", members: ["acme-co--jane@example_com"] });
      await expect(TeamChat.from(configured)!.leaveChannel("jane@example.com", "messaging:x"))
        .rejects.toThrow(/not a member/);
      fakeStream({ name: "Private", members: ["acme-co--bob@example_com"] });
      await expect(TeamChat.from(configured)!.leaveChannel("jane@example.com", "messaging:y"))
        .rejects.toThrow(/not a member/);
      fakeStream({ name: "Launch", members: ["acme-co--jane@example_com", "acme-co--bob@example_com"] });
      await expect(TeamChat.from(configured)!.updateChannel("jane@example.com", "messaging:abc",
          { addMembers: ["acme-co--stranger@example_com"] })).rejects.toThrow(/members of this team/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("leaves a group by removing the caller", async () => {
    const realFetch = globalThis.fetch;
    const calls = fakeStream({ name: "Launch", members: ["acme-co--jane@example_com", "acme-co--bob@example_com"] });
    try {
      await TeamChat.from(configured)!.leaveChannel("jane@example.com", "messaging:abc");
      const leave = calls.find(c => c.method === "POST" && c.url.includes("/channels/messaging/abc?"));
      expect(leave?.body.remove_members).toEqual(["acme-co--jane@example_com"]);
      expect(leave?.body.message.text).toBe("Jane Doe left");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  function fakeStreamForNudges(opts: {
    message: { cid: string; user: string; mentioned?: string[]; type?: string };
    channel: { name?: string; members: { id: string; name?: string; online?: boolean }[] };
    messages?: { id: string; user: string; name?: string; text: string; created_at: string }[];
    read?: { user: string; last_read: string; unread: number }[];
    muted?: boolean;
  }) {
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/team")) {
        return Response.json({ team: { members: [
          { email: "jane@example.com", displayName: "Jane Doe", role: "member", createdAt: 0 },
          { email: "bob@example.com", displayName: "Bob", role: "member", createdAt: 0 },
          { email: "eve@example.com", displayName: "Eve", role: "member", createdAt: 0 },
        ], invitations: [] } });
      }
      if (url.includes("/messages/")) {
        return Response.json({ message: {
          cid: opts.message.cid, user: { id: opts.message.user }, type: opts.message.type ?? "regular",
          mentioned_users: (opts.message.mentioned ?? []).map(id => ({ id })),
        } });
      }
      if (url.includes("/query?")) {
        return Response.json({
          channel: { team: "acme-co", name: opts.channel.name },
          members: opts.channel.members.map(m => ({ user_id: m.id, user: { id: m.id, name: m.name, online: m.online } })),
          messages: (opts.messages ?? []).map(m => ({ id: m.id, type: "regular", text: m.text, created_at: m.created_at,
            user: { id: m.user, name: m.name } })),
          read: (opts.read ?? []).map(r => ({ user: { id: r.user }, last_read: r.last_read, unread_messages: r.unread })),
        });
      }
      if (url.includes("/channels?")) return Response.json({ channels: opts.muted ? [{}] : [] });
      if (url.includes("/notifications/discuss-unread")) return Response.json({ ok: true, notified: true });
      return Response.json({});
    }) as typeof fetch;
    return calls;
  }

  const JANE = "acme-co--jane@example_com", BOB = "acme-co--bob@example_com", EVE = "acme-co--eve@example_com";

  it("nudges the other person of a DM, and only @mentioned members of a group", async () => {
    const realFetch = globalThis.fetch;
    try {
      fakeStreamForNudges({ message: { cid: "messaging:dm", user: JANE }, channel: { members: [{ id: JANE }, { id: BOB }] } });
      expect(await TeamChat.from(configured)!.recipientsToNudge("jane@example.com", "messaging:dm", "m1"))
        .toEqual(["bob@example.com"]);
      fakeStreamForNudges({ message: { cid: "messaging:grp", user: JANE, mentioned: [EVE] },
        channel: { name: "Launch", members: [{ id: JANE }, { id: BOB }, { id: EVE }] } });
      expect(await TeamChat.from(configured)!.recipientsToNudge("jane@example.com", "messaging:grp", "m2"))
        .toEqual(["eve@example.com"]);
      fakeStreamForNudges({ message: { cid: "messaging:grp", user: JANE },
        channel: { name: "Launch", members: [{ id: JANE }, { id: BOB }] } });
      expect(await TeamChat.from(configured)!.recipientsToNudge("jane@example.com", "messaging:grp", "m3")).toEqual([]);
      // Someone else's message never schedules nudges on the caller's behalf.
      fakeStreamForNudges({ message: { cid: "messaging:dm", user: BOB }, channel: { members: [{ id: JANE }, { id: BOB }] } });
      expect(await TeamChat.from(configured)!.recipientsToNudge("jane@example.com", "messaging:dm", "m4")).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("builds an unread digest only for offline, unmuted recipients with unread messages", async () => {
    const realFetch = globalThis.fetch;
    const base = {
      message: { cid: "messaging:dm", user: JANE },
      channel: { members: [{ id: JANE, name: "Jane Doe" }, { id: BOB, name: "Bob", online: false }] },
      messages: [
        { id: "a", user: BOB, name: "Bob", text: "old", created_at: "2026-08-25T10:00:00Z" },
        { id: "b", user: JANE, name: "Jane Doe", text: "hey", created_at: "2026-08-25T11:00:00Z" },
        { id: "c", user: JANE, name: "Jane Doe", text: "demo at 3?", created_at: "2026-08-25T11:01:00Z" },
      ],
      read: [{ user: BOB, last_read: "2026-08-25T10:30:00Z", unread: 2 }],
    };
    try {
      fakeStreamForNudges(base);
      const digest = await TeamChat.from(configured)!.unreadDigest("bob@example.com", "messaging:dm");
      expect(digest).toMatchObject({ cid: "messaging:dm", title: "Jane Doe", isGroup: false });
      expect(digest!.messages.map(m => m.text)).toEqual(["hey", "demo at 3?"]);
      expect(digest!.messages[0].from).toBe("Jane Doe");

      fakeStreamForNudges({ ...base, read: [{ user: BOB, last_read: "2026-08-25T12:00:00Z", unread: 0 }] });
      expect(await TeamChat.from(configured)!.unreadDigest("bob@example.com", "messaging:dm")).toBeNull();

      fakeStreamForNudges({ ...base, channel: { members: [{ id: JANE }, { id: BOB, online: true }] } });
      expect(await TeamChat.from(configured)!.unreadDigest("bob@example.com", "messaging:dm")).toBeNull();

      fakeStreamForNudges({ ...base, muted: true });
      expect(await TeamChat.from(configured)!.unreadDigest("bob@example.com", "messaging:dm")).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("emails the digest through the central directory", async () => {
    const realFetch = globalThis.fetch;
    const calls = fakeStreamForNudges({ message: { cid: "x", user: JANE }, channel: { members: [] } });
    try {
      const digest = { cid: "messaging:dm", title: "Jane Doe", isGroup: false,
        messages: [{ from: "Jane Doe", text: "hey", at: 1 }] };
      expect(await TeamChat.from(configured)!.emailUnread("bob@example.com", digest)).toBe(true);
      const call = calls.find(c => c.url.endsWith("/notifications/discuss-unread"));
      expect(call?.body).toEqual({ recipientEmail: "bob@example.com", ...digest });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
