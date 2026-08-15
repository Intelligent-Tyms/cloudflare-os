import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import {
  SUGGESTED_MODELS, freePlanModelNames, isFreePlanModel,
} from "@gadgets/workshop-shared/api";

// In platform AI Gateway mode the provider keys are Tyms-owned, and metering falls back to pi's
// catalog-priced estimate whenever the gateway cost log is unavailable. A SUGGESTED model missing
// from pi's catalog would meter that fallback as zero -- silent margin leakage -- so
// getModelViaGateway() refuses to serve unpriced non-Workers-AI models at runtime, and this test
// catches the gap at CI time instead: if it fails after adding a model, bump pi so its catalog
// covers the new id. Workers AI models are exempt (the gateway log prices them authoritatively,
// and their worst case is small); ollama is BYOK-only and never served through the gateway.
describe("SUGGESTED_MODELS catalog pricing", () => {
  const catalogs = {
    anthropic: ANTHROPIC_MODELS,
    openai: OPENAI_MODELS,
    google: GOOGLE_MODELS,
  } as const;

  for (const [provider, catalog] of Object.entries(catalogs)) {
    it(`every ${provider} model has positive pi catalog pricing`, () => {
      const models = SUGGESTED_MODELS[provider as keyof typeof catalogs];
      expect(Object.keys(models).length).toBeGreaterThan(0);
      for (const id of Object.keys(models)) {
        const entry = (catalog as Record<string, { cost?: { input: number; output: number } }>)[id];
        expect(entry, `${provider} model "${id}" is missing from pi's catalog`).toBeDefined();
        expect(entry!.cost?.input, `${provider} model "${id}" has no input price`)
            .toBeGreaterThan(0);
        expect(entry!.cost?.output, `${provider} model "${id}" has no output price`)
            .toBeGreaterThan(0);
      }
    });
  }
});

describe("free-plan model flags", () => {
  it("marks only the low-cost models as free-plan", () => {
    // The free plan is platform-funded, so it must never include the premium models. This list
    // is a deliberate product decision -- update it consciously, not incidentally.
    const freeIds = Object.values(SUGGESTED_MODELS)
        .flatMap(models => Object.entries(models))
        .filter(([, model]) => model.freePlan)
        .map(([id]) => id)
        .sort();
    expect(freeIds).toEqual([
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai-org/glm-5.2",
      "claude-haiku-4-5",
    ]);
  });

  it("resolves flags through the helpers", () => {
    expect(isFreePlanModel("claude-haiku-4-5")).toBe(true);
    expect(isFreePlanModel("claude-opus-5")).toBe(false);
    expect(isFreePlanModel("no-such-model")).toBe(false);
    expect(freePlanModelNames()).toContain("Claude Haiku 4.5");
    expect(freePlanModelNames()).not.toContain("Claude Opus 5");
  });
});
