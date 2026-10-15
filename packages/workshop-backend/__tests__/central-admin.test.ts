import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { CENTRAL_ADMIN_METHODS, handleCentralAdmin, parseCentralAdminClaims } from "../src/central-admin";
import { CentralAdminApi } from "../src/admin-settings";

describe("central admin claims", () => {
  const call = { purpose: "admin", sub: "Owner@Acme.com", method: "provisionIntelligence", args: ["data"] };

  it("accept an admin call naming an allowed method", () => {
    expect(parseCentralAdminClaims(call))
        .toEqual({ actor: "owner@acme.com", method: "provisionIntelligence", args: ["data"] });
    expect(parseCentralAdminClaims({ ...call, method: "getIntelligenceOverview", args: undefined }))
        .toMatchObject({ args: [] });
  });

  it("refuse other purposes, actors without an email, unlisted methods and extra arguments", () => {
    expect(parseCentralAdminClaims({ ...call, purpose: "signout" })).toBeNull();
    expect(parseCentralAdminClaims({ ...call, purpose: undefined })).toBeNull();
    expect(parseCentralAdminClaims({ ...call, sub: "owner" })).toBeNull();
    expect(parseCentralAdminClaims({ ...call, method: "getSettings" })).toBeNull();
    expect(parseCentralAdminClaims({ ...call, method: "toString" })).toBeNull();
    expect(parseCentralAdminClaims({ ...call, args: ["data", "more"] })).toBeNull();
    expect(parseCentralAdminClaims({ ...call, args: "data" })).toBeNull();
  });

  it("only list methods the central admin API has", () => {
    for (const method of Object.keys(CENTRAL_ADMIN_METHODS)) {
      expect(typeof (CentralAdminApi.prototype as unknown as Record<string, unknown>)[method], method).toBe("function");
    }
  });
});

describe("handleCentralAdmin", () => {
  let privateKey: CryptoKey;
  let env: Cloudflare.Env;
  // Never reached: these calls are refused, or answer without touching the settings DO.
  const ctx = { exports: { AdminSettings: { getByName: () => ({}) } } } as unknown as ExecutionContext;

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = pair.privateKey;
    const spki = (await exportSPKI(pair.publicKey)).replace(/-----[A-Z ]+-----|\s/g, "");
    env = {
      CENTRAL_LOGIN_URL: "https://home.example.com/login?slug=acme",
      HANDOFF_PUBLIC_KEY: spki,
      HANDOFF_AUDIENCE: "acme",
    } as unknown as Cloudflare.Env;
  });

  const token = (claims: Record<string, unknown>, audience = "acme", key = privateKey) =>
    new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).setSubject("owner@acme.com")
        .setAudience(audience).setIssuedAt().setExpirationTime("60s").sign(key);
  const post = async (body: unknown) => handleCentralAdmin(
      new Request("https://acme.example.com/api/central/admin", { method: "POST", body: JSON.stringify(body) }),
      env, ctx);

  it("runs an allowed call and returns its result", async () => {
    // No tenant API configured here, so the overview is null without any other call.
    const res = await post({ token: await token({ purpose: "admin", method: "getIntelligenceOverview" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: null });
  });

  it("checks arguments as an RPC from the admin page would, and returns refusals as errors", async () => {
    const res = await post({ token: await token({ purpose: "admin", method: "provisionIntelligence", args: ["nope"] }) });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/provisionIntelligence\[0\]/);
  });

  it("refuses tokens for another workspace, other keys, other purposes and unlisted methods", async () => {
    const other = (await generateKeyPair("EdDSA")).privateKey;
    for (const t of [
      await token({ purpose: "admin", method: "getIntelligenceOverview" }, "globex"),
      await token({ purpose: "admin", method: "getIntelligenceOverview" }, "acme", other),
      await token({ purpose: "signout" }),
      await token({ purpose: "admin", method: "getSettings", args: ["x"] }),
    ]) {
      expect((await post({ token: t })).status).toBe(403);
    }
    expect((await post({})).status).toBe(400);
  });

  it("is off without central login", async () => {
    const res = await handleCentralAdmin(
        new Request("https://acme.example.com/api/central/admin", { method: "POST", body: "{}" }),
        {} as Cloudflare.Env, ctx);
    expect(res.status).toBe(404);
  });
});
