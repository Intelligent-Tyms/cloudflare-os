import { describe, expect, it } from "vitest";
import type { AiChatMessage, AlwaysAvailableResource } from "@gadgets/workshop-shared/api";
import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES, AGENT_CATALOG_MAX_ID_LENGTH,
  AGENT_CATALOG_MAX_TITLE_LENGTH, AGENT_SKILLS_MAX_ENTRIES,
  boundAgentCatalog, boundAgentSkillList,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  completeAgentSkillSnapshot, findCatalogChanges, formatAgentCatalogPrompt,
  formatAlwaysAvailableResourcesPrompt, formatAvailableSkillsPrompt, formatCatalogChange,
  normalizeAgentCatalog, normalizeAgentSkillList, removeDisabledSkillEntries,
  removeDisabledSkills, seenAlwaysAvailableResources,
} from "../src/agent-catalog";

describe("normalizeAgentCatalog", () => {
  it("sorts entries, strips control characters, and truncates long fields to the max bounds", () => {
    let catalog = normalizeAgentCatalog({
      entries: [
        { id: "2".repeat(AGENT_CATALOG_MAX_ID_LENGTH + 10), title: "  Zebra\u0000  ",
          description: "D".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH + 100) },
        { id: "1", title: "T".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH + 50), description: " First collection " },
      ],
    });

    expect(catalog).toEqual({
      entries: [
        { id: "1", title: "T".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH), description: "First collection" },
        { id: "2".repeat(AGENT_CATALOG_MAX_ID_LENGTH), title: "Zebra",
          description: "D".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH) },
      ],
    });
  });

  it("truncates to the maximum entry count", () => {
    let entries = Array.from({ length: AGENT_CATALOG_MAX_ENTRIES + 5 }, (_, i) => ({
      id: `${i}`, title: `Collection ${String(i).padStart(2, "0")}`, description: "x",
    }));

    let catalog = normalizeAgentCatalog({ entries });

    expect(catalog.entries.length).toBe(AGENT_CATALOG_MAX_ENTRIES);
    expect(catalog.truncated).toBe(true);
  });

  it("drops from the tail in provider order, then sorts the survivors", () => {
    // The gatekeeper puts what must survive first (the Context Library leads with its collections),
    // so a title that sorts last must still be kept when the cap clamps the list.
    let entries = [
      {id: "keep", title: "Zulu collection", description: "survives despite sorting last"},
      ...Array.from({length: AGENT_CATALOG_MAX_ENTRIES}, (_, i) => ({
        id: `skill${i}`, title: `aa-skill-${String(i).padStart(4, "0")}`, description: "x",
      })),
    ];

    let catalog = normalizeAgentCatalog({entries});

    expect(catalog.entries).toHaveLength(AGENT_CATALOG_MAX_ENTRIES);
    expect(catalog.entries.at(-1)).toEqual(entries[0]);
    expect(catalog.truncated).toBe(true);
  });

  it("normalizes control characters without emitting false truncation", () => {
    expect(normalizeAgentCatalog({
      entries: [{id: "id", title: "Title\u009f", description: "Description"}],
    })).toEqual({
      entries: [{id: "id", title: "Title", description: "Description"}],
    });
  });

  // The skill marker routes deployment skill curation (removeDisabledSkillEntries), so it must
  // survive normalization — and only as the literal true, since the catalog is untrusted data.
  it("preserves the skill marker as literal true and drops other truthy values", () => {
    let catalog = normalizeAgentCatalog({
      entries: [
        { id: "1", title: "convert-docs", description: "Agent Skill.", skill: true },
        { id: "2", title: "Runbooks", description: "A collection" },
        { id: "3", title: "sneaky", description: "x", skill: "yes" as unknown as boolean },
      ],
    });

    expect(catalog.entries).toEqual([
      { id: "1", title: "convert-docs", description: "Agent Skill.", skill: true },
      { id: "2", title: "Runbooks", description: "A collection" },
      { id: "3", title: "sneaky", description: "x" },
    ]);
  });

  it("preserves provider truncation and removes unusable entries", () => {
    let catalog = normalizeAgentCatalog({
      entries: [
        { id: "", title: "Missing ID", description: "Ignored" },
        { id: "valid", title: "", description: "Ignored" },
        { id: "valid", title: "Useful", description: "Catalog entry" },
      ],
      truncated: true,
    });

    expect(catalog).toEqual({
      entries: [{ id: "valid", title: "Useful", description: "Catalog entry" }],
      truncated: true,
    });
  });

  it("inlines each resource's catalog as JSON and omits it when empty", () => {
    let catalog = {
      entries: [{ id: "abc", title: "Runbooks", description: "deploy steps" }],
      truncated: true,
    };
    let serialized =
      '{"entries":[{"id":"abc","title":"Runbooks","description":"deploy steps"}],"truncated":true}';

    expect(formatAgentCatalogPrompt(catalog)).toBe(`\n${serialized}`);
    expect(formatAgentCatalogPrompt({entries: []})).toBe("");
    expect(formatAgentCatalogPrompt(null)).toBe("");

    let message = formatAlwaysAvailableResourcesPrompt([
      {title: "Context", name: "CONTEXT", catalog},
      {title: "Empty", name: "EMPTY", catalog: {entries: []}},
    ]);
    expect(message).toContain(`- Context: \`env.CONTEXT\`\n${serialized}`);
    // A resource with no catalog gets just its env line, nothing inlined.
    expect(message).toContain("- Empty: `env.EMPTY`");
    expect(message).not.toContain("- Empty: `env.EMPTY`\n{");
  });
});

describe("removeDisabledSkillEntries", () => {
  let catalog = {
    entries: [
      { id: "1", title: "convert-docs", description: "Agent Skill.", skill: true as const },
      { id: "2", title: "summarize-tickets", description: "Agent Skill.", skill: true as const },
      // A collection whose title collides with a disabled skill name must survive: curation is
      // scoped to entries the provider marked as skills.
      { id: "3", title: "convert-docs", description: "A collection about conversions" },
    ],
    truncated: true,
  };

  it("drops only skill entries whose name is disabled", () => {
    expect(removeDisabledSkillEntries(catalog, new Set(["convert-docs"]))).toEqual({
      entries: [
        { id: "2", title: "summarize-tickets", description: "Agent Skill.", skill: true },
        { id: "3", title: "convert-docs", description: "A collection about conversions" },
      ],
      truncated: true,
    });
  });

  it("returns the catalog unchanged when nothing applies", () => {
    // Same object, not a copy: this runs on every turn over cached snapshots.
    expect(removeDisabledSkillEntries(catalog, new Set())).toBe(catalog);
    expect(removeDisabledSkillEntries(catalog, new Set(["unknown"]))).toBe(catalog);
    expect(removeDisabledSkillEntries(null, new Set(["convert-docs"]))).toBe(null);
  });
});

describe("boundAgentCatalog", () => {
  it("clamps the count and each field, keeping the order it was given", () => {
    let entries = Array.from({length: AGENT_CATALOG_MAX_ENTRIES + 5}, (_, index) => ({
      id: `${index}-${"i".repeat(AGENT_CATALOG_MAX_ID_LENGTH)}`,
      title: `${index}-${"t".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH)}`,
      description: `${index}-${"d".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH)}`,
    }));

    let catalog = boundAgentCatalog(entries);

    expect(catalog.entries).toHaveLength(AGENT_CATALOG_MAX_ENTRIES);
    expect(catalog.entries[0].id).toHaveLength(AGENT_CATALOG_MAX_ID_LENGTH);
    expect(catalog.entries[0].title).toHaveLength(AGENT_CATALOG_MAX_TITLE_LENGTH);
    expect(catalog.entries[0].description).toHaveLength(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH);
    // Order preserved, so the caller decides which entries survive.
    expect(catalog.entries[0].id.startsWith("0-")).toBe(true);
    expect(catalog.truncated).toBe(true);
  });

  it("reports no truncation when everything fits", () => {
    expect(boundAgentCatalog([{id: "a", title: "A", description: "d"}])).toEqual({
      entries: [{id: "a", title: "A", description: "d"}],
      truncated: false,
    });
  });
});

describe("agent skill lists", () => {
  it("normalizes, deduplicates by name, and clamps the count", () => {
    let list = normalizeAgentSkillList({
      skills: [
        { id: "b", name: "deploy", description: "Second copy" },
        { id: "a", name: "deploy", description: "First copy" },
        { id: "c", name: "", description: "unusable" },
        { id: "d", name: "audit", description: "  Audit   things  " },
      ],
    });

    // Sorted by name; the duplicate name keeps the first (lowest-id) entry.
    expect(list).toEqual({
      skills: [
        { id: "d", name: "audit", description: "Audit things" },
        { id: "a", name: "deploy", description: "First copy" },
      ],
    });

    let overfull = normalizeAgentSkillList({
      skills: Array.from({ length: AGENT_SKILLS_MAX_ENTRIES + 3 }, (_, i) => ({
        id: `${i}`, name: `skill-${String(i).padStart(3, "0")}`, description: "x",
      })),
    });
    expect(overfull.skills.length).toBe(AGENT_SKILLS_MAX_ENTRIES);
    expect(overfull.truncated).toBe(true);
  });

  it("bounds provider-side lists", () => {
    let bounded = boundAgentSkillList(Array.from({ length: AGENT_SKILLS_MAX_ENTRIES + 1 }, (_, i) => ({
      id: `${i}`.repeat(300), name: `n${i}`.repeat(60), description: "d".repeat(2000),
    })));
    expect(bounded.skills).toHaveLength(AGENT_SKILLS_MAX_ENTRIES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.skills[0].id).toHaveLength(256);
    expect(bounded.skills[0].name).toHaveLength(64);
    expect(bounded.skills[0].description).toHaveLength(1024);
  });

  it("removes disabled skills and otherwise returns the same object", () => {
    let list = {
      skills: [
        { id: "1", name: "convert-docs", description: "x" },
        { id: "2", name: "audit", description: "y" },
      ],
    };
    expect(removeDisabledSkills(list, new Set(["convert-docs"]))).toEqual({
      skills: [{ id: "2", name: "audit", description: "y" }],
    });
    // Same object, not a copy: this runs on every turn over cached snapshots.
    expect(removeDisabledSkills(list, new Set())).toBe(list);
    expect(removeDisabledSkills(null, new Set(["audit"]))).toBe(null);
  });

  it("renders the <available_skills> section with XML escaping, or nothing", () => {
    expect(formatAvailableSkillsPrompt([])).toBe("");

    let prompt = formatAvailableSkillsPrompt([
      { id: "1", name: "convert-docs", description: "Convert <docs> & \"files\"" },
    ]);
    expect(prompt).toContain("loadSkill");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>convert-docs</name>");
    expect(prompt).toContain(
        "<description>Convert &lt;docs&gt; &amp; &quot;files&quot;</description>");
    expect(prompt).toContain("</available_skills>");
  });

  it("caches skill snapshots like catalogs", async () => {
    let calls = 0;
    let first = await completeAgentSkillSnapshot(undefined, [1, 2], async gatekeeperId => {
      calls++;
      return gatekeeperId === 1
          ? {skills: [{id: "a", name: "audit", description: "x"}]}
          : null;
    });
    let second = await completeAgentSkillSnapshot(first.snapshots, [1, 2], async () => {
      throw new Error("existing snapshots must not be reloaded");
    });

    expect(first).toEqual({
      snapshots: [
        {gatekeeperId: 1, skills: {skills: [{id: "a", name: "audit", description: "x"}]}},
        {gatekeeperId: 2, skills: null},
      ],
      changed: true,
    });
    expect(second).toEqual({snapshots: first.snapshots, changed: false});
    expect(calls).toBe(2);
  });
});


let skill = (title: string) => ({id: title, title, description: `The ${title} skill.`});
let skills = (...titles: string[]): AlwaysAvailableResource =>
  ({name: "CONTEXT", title: "Skills", catalog: {entries: titles.map(skill)}});
let unloaded: AlwaysAvailableResource = {name: "CONTEXT", title: "Skills", catalog: null};
let seen = (resource: AlwaysAvailableResource) => new Map([[resource.name, resource]]);
let note = (sequence: number, resource: AlwaysAvailableResource): AiChatMessage => ({
  chatId: 1, sequence, timestamp: new Date(0), author: {type: "agent", id: "m", name: "M"},
  type: "catalogChange", resources: [resource],
});

describe("catalog changes", () => {
  it("reports a changed catalog and a resource the agent hasn't seen, not an unchanged one", () => {
    let tasks: AlwaysAvailableResource = {name: "TASKS", title: "Tasks", catalog: null};
    expect(findCatalogChanges(seen(skills("Tax")), [skills("Tax", "Travel"), tasks]))
      .toEqual([skills("Tax", "Travel"), tasks]);
    expect(findCatalogChanges(seen(skills("Tax")), [skills("Tax")])).toEqual([]);
  });

  it("does not take a catalog that failed to load for a change", () => {
    expect(findCatalogChanges(seen(skills("Tax")), [unloaded])).toEqual([]);
  });

  it("compares a catalog the agent saw missing as an empty one", () => {
    expect(findCatalogChanges(seen(unloaded), [skills()])).toEqual([]);
    expect(findCatalogChanges(seen(unloaded), [skills("Tax")])).toEqual([skills("Tax")]);
  });

  it("tells the agent the entries added and those no longer listed, not those kept", () => {
    let text = formatCatalogChange(skills("Travel", "Visa"), skills("Tax", "Travel"));

    expect(text).toContain(`Added: [${JSON.stringify(skill("Visa"))}]`);
    expect(text).toContain(`No longer listed: [${JSON.stringify(skill("Tax"))}]`);
    expect(text).not.toContain(JSON.stringify(skill("Travel")));
  });

  it("applies only the changes recorded before a sequence", () => {
    let messages = [note(3, skills("Tax", "Travel")), note(7, skills("Travel"))];

    expect(seenAlwaysAvailableResources([skills("Tax")], messages, 7).get("CONTEXT"))
      .toEqual(skills("Tax", "Travel"));
  });
});
