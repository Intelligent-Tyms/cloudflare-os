import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiGatewayConfig,
  AiGatewayLogRetryableError,
  getAiGatewayLogCost,
} from "../src/ai-gateway.js";

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    WORKERS_AI: {} as Ai,
    ...overrides,
  } as Cloudflare.Env;
}

describe("getAiGatewayLogCost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads cross-account log cost through the REST API", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: { cost: 1.25 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log/id")).resolves.toBe(1.25);

    expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/" +
        "ai-gateway/gateways/platform-gateway/logs/log%2Fid",
        {
          headers: { Authorization: "Bearer read-run-token" },
          signal: expect.any(AbortSignal),
        });
  });

  it("uses the binding for same-account log cost", async () => {
    const getLog = vi.fn(async () => ({ cost: 0.5 }));
    const gateway = vi.fn(() => ({ getLog }));

    await expect(getAiGatewayLogCost(env({
      WORKERS_AI: { gateway } as unknown as Ai,
    }), { gateway: "platform-gateway" }, "log-id")).resolves.toBe(0.5);

    expect(gateway).toHaveBeenCalledWith("platform-gateway");
    expect(getLog).toHaveBeenCalledWith("log-id");
  });

  it("classifies same-account binding failures as retryable", async () => {
    const getLog = vi.fn(async () => { throw new Error("log not found"); });
    const gateway = vi.fn(() => ({ getLog }));

    await expect(getAiGatewayLogCost(env({
      WORKERS_AI: { gateway } as unknown as Ai,
    }), { gateway: "platform-gateway" }, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("classifies cross-account network failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unavailable"); }));

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log-id")).rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("classifies cross-account response body failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("response body reset"); },
    } as Response)));

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log-id")).rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("rejects failed or malformed cross-account responses", async () => {
    const responses = [
      new Response(null, { status: 403 }),
      Response.json({ success: true, result: { cost: "unknown" } }),
      Response.json({ success: true, result: { cost: -1 } }),
      Response.json({ success: true, result: {} }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 408 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const route = {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    };

    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log request failed with status 403.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log response contained an invalid cost.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log response contained an invalid cost.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });
});

// The two admin-curation chokepoints: getModelList() decides what pickers offer, resolveModel()
// decides what actually runs. Both must honor the disabled set -- user selections ride
// localStorage and gadget bindings snapshot configs, so stale/crafted ids reach resolution and
// the list filter alone is not enforcement.
describe("AiGatewayConfig model curation", () => {
  const gwConfig = new AiGatewayConfig(env({
    CF_AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CF_AI_GATEWAY_API_TOKEN: "test-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
  }));

  it("offers the catalog for enabled providers and omits disabled models, preserving order", () => {
    const all = gwConfig.getModelList();
    expect(all.map(m => m.id)).toContain("claude-opus-5");
    expect(all.map(m => m.id)).toContain("@cf/zai-org/glm-5.2");
    // openai is not an enabled provider on this gateway.
    expect(all.map(m => m.id)).not.toContain("gpt-5.6-sol");

    const curated = gwConfig.getModelList(new Set(["claude-opus-5"]));
    expect(curated.map(m => m.id)).not.toContain("claude-opus-5");
    // Filtering removes entries without reordering the survivors (first entry = default model).
    expect(curated.map(m => m.id)).toEqual(all.map(m => m.id).filter(id => id !== "claude-opus-5"));
  });

  it("refuses to resolve a disabled model", () => {
    expect(gwConfig.resolveModel("claude-opus-5")).toBeDefined();
    expect(gwConfig.resolveModel("claude-opus-5", new Set(["claude-opus-5"]))).toBeUndefined();
    // Other models are unaffected by an unrelated disable.
    expect(gwConfig.resolveModel("claude-sonnet-5", new Set(["claude-opus-5"]))).toBeDefined();
    // Models outside the enabled providers never resolve, disabled set or not.
    expect(gwConfig.resolveModel("gpt-5.6-sol")).toBeUndefined();
  });

  it("keeps the quick model exempt from curation", () => {
    // Title generation is internal plumbing; disabling every catalog model must not break it.
    const quick = gwConfig.getQuickModelConfig();
    expect(quick?.provider).toBe("cloudflare");
    expect(quick?.model).toBeTruthy();
  });
});
