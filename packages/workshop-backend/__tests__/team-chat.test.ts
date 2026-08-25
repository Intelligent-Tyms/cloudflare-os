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
});
