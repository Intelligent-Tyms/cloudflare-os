import { describe, expect, it } from "vitest";
import { AssistantProfile, MAX_ASSISTANT_FIELD_LENGTH, MAX_ASSISTANT_NAME_LENGTH, MAX_ASSISTANT_PERSONA_LENGTH } from "@gadgets/workshop-shared/api";
import { validateAssistantProfile } from "../src/assistant-profile.js";

function profile(overrides: Partial<AssistantProfile> = {}): AssistantProfile {
  return {
    assistantName: "Zuri",
    persona: "Direct, light humor.",
    role: "Head of Growth",
    targets: "Close 3 partnerships this quarter",
    goals: "Grow revenue sustainably",
    timeZone: "Africa/Kampala",
    ...overrides,
  };
}

describe("validateAssistantProfile", () => {
  it("returns a trimmed copy of a valid profile", () => {
    let clean = validateAssistantProfile(profile({ assistantName: "  Zuri  ", role: " CEO " }));
    expect(clean.assistantName).toBe("Zuri");
    expect(clean.role).toBe("CEO");
    expect(clean.timeZone).toBe("Africa/Kampala");
  });

  it("accepts an all-empty profile", () => {
    let empty = profile({
      assistantName: "", persona: "", role: "", targets: "", goals: "", timeZone: "",
    });
    expect(validateAssistantProfile(empty)).toEqual(empty);
  });

  it("drops unknown properties rather than storing them", () => {
    let dirty = { ...profile(), extra: "nope" } as AssistantProfile;
    expect("extra" in validateAssistantProfile(dirty)).toBe(false);
  });

  it("enforces per-field length budgets after trimming", () => {
    expect(() => validateAssistantProfile(
        profile({ assistantName: "x".repeat(MAX_ASSISTANT_NAME_LENGTH + 1) })))
        .toThrow(/assistant name is too long/);
    expect(() => validateAssistantProfile(
        profile({ persona: "x".repeat(MAX_ASSISTANT_PERSONA_LENGTH + 1) })))
        .toThrow(/persona is too long/);
    expect(() => validateAssistantProfile(
        profile({ goals: "x".repeat(MAX_ASSISTANT_FIELD_LENGTH + 1) })))
        .toThrow(/goals is too long/);
    // Whitespace beyond the limit is trimmed away, not counted against it.
    let padded = "x".repeat(MAX_ASSISTANT_NAME_LENGTH) + "   ";
    expect(validateAssistantProfile(profile({ assistantName: padded })).assistantName)
        .toBe("x".repeat(MAX_ASSISTANT_NAME_LENGTH));
  });

  it("rejects non-string fields", () => {
    expect(() => validateAssistantProfile(profile({ persona: 42 as unknown as string })))
        .toThrow(/persona must be a string/);
  });

  it("validates the time zone as an IANA name", () => {
    expect(() => validateAssistantProfile(profile({ timeZone: "Kampala Standard Time" })))
        .toThrow(/Unknown time zone/);
    expect(validateAssistantProfile(profile({ timeZone: "UTC" })).timeZone).toBe("UTC");
  });
});
