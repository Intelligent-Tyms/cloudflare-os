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
});
