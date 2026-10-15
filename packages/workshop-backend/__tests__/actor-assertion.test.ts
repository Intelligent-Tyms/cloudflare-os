import { afterEach, describe, expect, it } from "vitest";
import {
  ACTOR_ASSERTION_REFRESH_MARGIN_MS,
  ActorAssertionImpl,
  hasActorAssertions,
  mintActorAssertion,
  resetActorAssertionCache,
} from "../src/actor-assertion";

const configured = {
  CENTRAL_TEAM_API_URL: "https://control.example.com/tenant-api",
  CENTRAL_TEAM_API_TOKEN: "acme-co:token",
} as unknown as Cloudflare.Env;

type Call = { url: string; authorization: string | null; body: any };

function stubFetch(handler: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const call = {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

describe("actor assertions", () => {
  afterEach(() => resetActorAssertionCache());

  it("is off without the central directory, and mints nothing then", async () => {
    expect(hasActorAssertions(configured)).toBe(true);
    for (const missing of ["CENTRAL_TEAM_API_URL", "CENTRAL_TEAM_API_TOKEN"]) {
      const env = { ...configured, [missing]: undefined } as unknown as Cloudflare.Env;
      expect(hasActorAssertions(env), missing).toBe(false);
      expect(await mintActorAssertion(env, { email: "ann@acme.test" })).toBeNull();
    }
  });

  it("posts the person under the team bearer and returns the assertion", async () => {
    const stub = stubFetch(() => Response.json({ token: "jwt", expiresAt: 1_000 }));
    try {
      const minted = await mintActorAssertion(configured, { email: "ann@acme.test" });
      expect(minted).toEqual({ token: "jwt", expiresAt: 1_000 });
      expect(stub.calls).toEqual([{
        url: "https://control.example.com/tenant-api/intelligence/actor",
        authorization: "Bearer acme-co:token",
        body: { email: "ann@acme.test" },
      }]);
    } finally {
      stub.restore();
    }
  });

  it("returns null when the workspace has no wiki, and throws on other failures", async () => {
    let stub = stubFetch(() => Response.json({ error: "not_provisioned" }, { status: 404 }));
    try {
      expect(await mintActorAssertion(configured, { email: "ann@acme.test" }))
          .toBeNull();
    } finally {
      stub.restore();
    }
    stub = stubFetch(() => Response.json({ error: "a valid email is required" }, { status: 400 }));
    try {
      await expect(mintActorAssertion(configured, { email: "nope" }))
          .rejects.toThrow("a valid email is required");
    } finally {
      stub.restore();
    }
  });

  it("caches a minted assertion until shortly before it expires", async () => {
    let now = 1_000_000;
    const expiresAt = now + 900_000;
    const stub = stubFetch(() => Response.json({ token: "jwt", expiresAt }));
    try {
      const provider = new ActorAssertionImpl(configured, "owner@acme.test", () => now);
      expect(await provider.mint()).toEqual({ token: "jwt", expiresAt });
      expect(await provider.mint()).toEqual({ token: "jwt", expiresAt });
      expect(stub.calls).toHaveLength(1);
      // Only the person: the control plane knows their role.
      expect(stub.calls[0].body).toEqual({ email: "owner@acme.test" });

      now = expiresAt - ACTOR_ASSERTION_REFRESH_MARGIN_MS + 1;
      await provider.mint();
      expect(stub.calls).toHaveLength(2);
    } finally {
      stub.restore();
    }
  });

  it("keeps a person's cache separate and forgets it when minting stops", async () => {
    let answer = (email: string) => Response.json({ token: `jwt-${email}`, expiresAt: Date.now() + 900_000 });
    const stub = stubFetch(call => answer(call.body.email));
    try {
      const ann = new ActorAssertionImpl(configured, "ann@acme.test");
      const bob = new ActorAssertionImpl(configured, "bob@acme.test");
      expect((await ann.mint())?.token).toBe("jwt-ann@acme.test");
      expect((await bob.mint())?.token).toBe("jwt-bob@acme.test");
      resetActorAssertionCache();
      answer = () => Response.json({ error: "not_provisioned" }, { status: 404 });
      expect(await ann.mint()).toBeNull();
      expect(stub.calls).toHaveLength(3);
    } finally {
      stub.restore();
    }
  });
});
