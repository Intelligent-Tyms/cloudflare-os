import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, defaultOutputFormatId, formatOrganizationProfile, parseAdminConfig, reorderFormats, resolveFormatOutput, sanitizeOutputOverrides, serializeAdminConfig } from "../src/admin-config.js";

describe("parseAdminConfig", () => {
  it("backfills fields missing from a config persisted before they existed", () => {
    // A config written before `formats` was added. Every consumer indexes into these, so a missing
    // field must come back as its default rather than undefined.
    let stored = JSON.stringify({ signupsEnabled: false, siteName: "acme" });
    let config = parseAdminConfig(stored);

    expect(config.signupsEnabled).toBe(false);
    expect(config.siteName).toBe("acme");
    expect(config.formats).toEqual([]);
    for (let key of Object.keys(DEFAULT_ADMIN_CONFIG)) {
      expect(config[key as keyof typeof config], key).toBeDefined();
    }
  });

  it("drops malformed format entries rather than the whole list", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "good", enabled: true, agentHint: "  prefer me  " },
        { enabled: true },                       // no blueprintId
        "nonsense",
        { blueprintId: "defaults-enabled" },     // enabled omitted
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "good", enabled: true, agentHint: "prefer me" },
      { blueprintId: "defaults-enabled", enabled: true },
    ]);
  });

  // setSkillEnabled() treats disabledSkills as a set; enforcement builds Sets from it. Junk values
  // and duplicates from a hand-edited or corrupted mirror must not survive a read.
  it("keeps disabled skills as a deduplicated list of non-empty strings", () => {
    let config = parseAdminConfig(JSON.stringify({
      disabledSkills: ["convert-docs", 7, "", "convert-docs", "summarize-tickets", null],
    }));

    expect(config.disabledSkills).toEqual(["convert-docs", "summarize-tickets"]);
    expect(parseAdminConfig(JSON.stringify({})).disabledSkills).toEqual([]);
  });

  // setModelEnabled() treats disabledModels as a set; the gateway chokepoints build Sets from it.
  // Same defenses as disabledSkills: junk values and duplicates must not survive a read.
  it("keeps disabled models as a deduplicated list of non-empty strings", () => {
    let config = parseAdminConfig(JSON.stringify({
      disabledModels: ["claude-opus-5", 7, "", "claude-opus-5", "@cf/zai-org/glm-5.2", null],
    }));

    expect(config.disabledModels).toEqual(["claude-opus-5", "@cf/zai-org/glm-5.2"]);
    expect(parseAdminConfig(JSON.stringify({})).disabledModels).toEqual([]);
  });

  // Everything downstream keys formats by blueprint id; setFormatOrder() in particular treats the
  // list as a set and refuses every reordering if it isn't one. A duplicate would make the menu
  // permanently unorderable, so it can't be allowed to survive a read.
  it("keeps only the first entry for a repeated blueprint", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "dup", enabled: true, agentHint: "first" },
        { blueprintId: "other", enabled: true },
        { blueprintId: "dup", enabled: false, agentHint: "second" },
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "dup", enabled: true, agentHint: "first" },
      { blueprintId: "other", enabled: true },
    ]);
  });
});

describe("reorderFormats", () => {
  let promoted = [
    { blueprintId: "a", enabled: true },
    { blueprintId: "b", enabled: true },
    { blueprintId: "c", enabled: true },
  ];

  it("rearranges into the order given", () => {
    expect(reorderFormats(promoted, ["c", "a", "b"]).map(f => f.blueprintId))
        .toEqual(["c", "a", "b"]);
  });

  // A repeated id passes both a length and a membership test, so without an explicit uniqueness
  // check it would drop "b" and leave a duplicate that makes every later reorder throw.
  it("refuses a repeated id", () => {
    expect(() => reorderFormats(promoted, ["a", "a", "c"])).toThrow(/exactly once/);
  });

  it("refuses a short list, a long list, and an unknown id", () => {
    expect(() => reorderFormats(promoted, ["a", "b"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "c", "a"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "z"])).toThrow(/exactly once/);
  });
});

describe("format presentation", () => {
  let declared = { id: "presentation", noun: "Slides", plural: "Slides", icon: "presentation" } as const;

  it("applies overrides over the blueprint's own declaration", () => {
    expect(resolveFormatOutput(declared, { noun: "Briefing", plural: "Briefings" }))
        .toEqual({ ...declared, noun: "Briefing", plural: "Briefings" });
  });

  it("has no format to offer when neither side supplies a complete one", () => {
    expect(resolveFormatOutput(undefined, { noun: "Briefing" })).toBeUndefined();
    expect(resolveFormatOutput(undefined, undefined)).toBeUndefined();
  });

  it("keeps only well-formed override fields", () => {
    expect(sanitizeOutputOverrides({ noun: "  Deck  ", icon: "notAnIcon", plural: "" }))
        .toEqual({ noun: "Deck" });
    expect(sanitizeOutputOverrides({ icon: "notAnIcon" })).toBeUndefined();
    expect(sanitizeOutputOverrides({ noun: "x".repeat(41) })).toBeUndefined();
  });

  it("derives a stable, valid grouping id without asking the admin for one", () => {
    expect(defaultOutputFormatId("acme.contract-memo")).toBe("acme.contract-memo");
    let long = "acme." + "contract-".repeat(8);
    expect(defaultOutputFormatId(long)).toBe(defaultOutputFormatId(long));
    expect(defaultOutputFormatId(long)).toHaveLength(40);
    expect(defaultOutputFormatId(long)).not.toBe(defaultOutputFormatId(long + "other"));
  });
});

describe("admin config site logo", () => {
  it("defaults legacy and malformed values to no custom logo", () => {
    expect(parseAdminConfig("{}").siteLogoConfigured).toBe(false);
    expect(parseAdminConfig('{"siteLogoConfigured":"yes"}').siteLogoConfigured).toBe(false);
  });

  it("round-trips configured logo state", () => {
    let config = parseAdminConfig('{"siteLogoConfigured":true}');
    expect(config.siteLogoConfigured).toBe(true);
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
  });
});

describe("formatOrganizationProfile", () => {
  it("returns \"\" when unset or whitespace-only", () => {
    expect(formatOrganizationProfile("")).toBe("");
    expect(formatOrganizationProfile("   \n ")).toBe("");
  });

  it("wraps the trimmed profile in a tagged, framed section", () => {
    let text = formatOrganizationProfile("  We call workspaces \"books\".  ");
    expect(text).toMatch(/^# About this organization\n/);
    expect(text).toContain("<organization_profile>\nWe call workspaces \"books\".\n</organization_profile>");
    // The admin-authored text appears only inside the tags, never in the framing.
    expect(text.slice(0, text.indexOf("<organization_profile>"))).not.toContain("books");
  });

  it("parses the stored field with a safe default", () => {
    expect(parseAdminConfig("{}").organizationProfile).toBe("");
    expect(parseAdminConfig('{"organizationProfile":42}').organizationProfile).toBe("");
    expect(parseAdminConfig('{"organizationProfile":"Tyms"}').organizationProfile).toBe("Tyms");
  });
});
