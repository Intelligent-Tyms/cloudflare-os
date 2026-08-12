import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES,
  AGENT_CATALOG_MAX_ID_LENGTH, AGENT_CATALOG_MAX_TITLE_LENGTH,
  AGENT_SKILL_MAX_DESCRIPTION_LENGTH, AGENT_SKILL_MAX_ID_LENGTH,
  AGENT_SKILL_MAX_NAME_LENGTH, AGENT_SKILLS_MAX_ENTRIES,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AgentCatalog, AgentSkillInfo, AgentSkillList } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.agent.catalog");

export type AgentCatalogSnapshot = {
  gatekeeperId: number;
  catalog: AgentCatalog | null;
};

// Cached skill list for one always-available resource, persisted beside the catalog snapshots in
// the chat context (see AiChatAgentContext.alwaysAvailableSkills).
export type AgentSkillSnapshot = {
  gatekeeperId: number;
  skills: AgentSkillList | null;
};

function normalizeText(value: string, maxLength: number): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// Workshop-side re-validation of a gatekeeper's catalog (defense-in-depth — the gatekeeper output is
// untrusted): strip control chars / collapse whitespace, drop unusable entries, sort, and re-clamp to
// the global AGENT_CATALOG_MAX_* bounds. This intentionally overlaps the provider-side
// boundAgentCatalog() (shared) — we don't trust the gatekeeper to have applied it. `id` keeps the full
// bound since it's the opaque key the agent passes back; only the title/description need shortening.
export function normalizeAgentCatalog(catalog: AgentCatalog): AgentCatalog {
  let entries = catalog.entries
      .map(entry => ({
        id: normalizeText(entry.id, AGENT_CATALOG_MAX_ID_LENGTH),
        title: normalizeText(entry.title, AGENT_CATALOG_MAX_TITLE_LENGTH),
        description: normalizeText(entry.description, AGENT_CATALOG_MAX_DESCRIPTION_LENGTH),
        // Coerced to a literal true/absent: the flag routes skill curation, so an untrusted truthy
        // value must not survive as anything else.
        ...(entry.skill === true ? {skill: true as const} : {}),
      }))
      .filter(entry => entry.id.length > 0 && entry.title.length > 0)
      .toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  let truncated = catalog.truncated === true || entries.length > AGENT_CATALOG_MAX_ENTRIES;
  return {
    entries: entries.slice(0, AGENT_CATALOG_MAX_ENTRIES),
    ...(truncated ? {truncated: true} : {}),
  };
}

// Generic core of the per-gatekeeper snapshot cache: keep entries for still-active gatekeepers,
// load the missing ones (isolating per-entry failures as null so one bad loader can't lose every
// other snapshot and abort the turn), and report whether anything changed. `what` labels failures
// in the log.
async function completeSnapshots<T>(
    existing: Array<{gatekeeperId: number, data: T | null}> | undefined,
    gatekeeperIds: number[],
    load: (gatekeeperId: number) => Promise<T | null>,
    what: string):
    Promise<{snapshots: Array<{gatekeeperId: number, data: T | null}>, changed: boolean}> {
  let activeIds = new Set(gatekeeperIds);
  let existingCount = existing?.length ?? 0;
  let byId = new Map(
      existing
          ?.filter(entry => activeIds.has(entry.gatekeeperId))
          .map(entry => [entry.gatekeeperId, entry.data]));
  let removedStaleEntries = byId.size !== existingCount;
  let missing = gatekeeperIds.filter(gatekeeperId => !byId.has(gatekeeperId));
  await Promise.all(missing.map(async gatekeeperId => {
    try {
      byId.set(gatekeeperId, await load(gatekeeperId));
    } catch (error) {
      logger.warn(`failed to load ${what}`, {
        event: "agent.catalog.load.failed", gatekeeperId, error,
      });
      byId.set(gatekeeperId, null);
    }
  }));
  return {
    snapshots: [...byId]
        .toSorted(([left], [right]) => left - right)
        .map(([gatekeeperId, data]) => ({gatekeeperId, data})),
    changed: missing.length > 0 || removedStaleEntries,
  };
}

export async function completeAgentCatalogSnapshot(
    existing: AgentCatalogSnapshot[] | undefined,
    gatekeeperIds: number[],
    loadCatalog: (gatekeeperId: number) => Promise<AgentCatalog | null>):
    Promise<{snapshots: AgentCatalogSnapshot[], changed: boolean}> {
  let {snapshots, changed} = await completeSnapshots(
      existing?.map(entry => ({gatekeeperId: entry.gatekeeperId, data: entry.catalog})),
      gatekeeperIds, loadCatalog, "agent catalog");
  return {
    snapshots: snapshots.map(({gatekeeperId, data}) => ({gatekeeperId, catalog: data})),
    changed,
  };
}

export async function completeAgentSkillSnapshot(
    existing: AgentSkillSnapshot[] | undefined,
    gatekeeperIds: number[],
    loadSkills: (gatekeeperId: number) => Promise<AgentSkillList | null>):
    Promise<{snapshots: AgentSkillSnapshot[], changed: boolean}> {
  let {snapshots, changed} = await completeSnapshots(
      existing?.map(entry => ({gatekeeperId: entry.gatekeeperId, data: entry.skills})),
      gatekeeperIds, loadSkills, "agent skills");
  return {
    snapshots: snapshots.map(({gatekeeperId, data}) => ({gatekeeperId, skills: data})),
    changed,
  };
}

// Workshop-side re-validation of a gatekeeper's skill list (defense-in-depth — the gatekeeper
// output is untrusted): strip control chars / collapse whitespace, drop unusable entries,
// deduplicate by name (the model loads skills by name, so a name resolves to exactly one skill),
// sort, and re-clamp to the global AGENT_SKILL_MAX_* bounds. Intentionally overlaps the
// provider-side boundAgentSkillList(), which we don't trust the gatekeeper to have applied.
export function normalizeAgentSkillList(list: AgentSkillList): AgentSkillList {
  let seen = new Set<string>();
  let skills = list.skills
      .map(skill => ({
        id: normalizeText(skill.id, AGENT_SKILL_MAX_ID_LENGTH),
        name: normalizeText(skill.name, AGENT_SKILL_MAX_NAME_LENGTH),
        description: normalizeText(skill.description, AGENT_SKILL_MAX_DESCRIPTION_LENGTH),
      }))
      .filter(skill => skill.id.length > 0 && skill.name.length > 0)
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .filter(skill => !seen.has(skill.name) && (seen.add(skill.name), true));
  let truncated = list.truncated === true || skills.length > AGENT_SKILLS_MAX_ENTRIES;
  return {
    skills: skills.slice(0, AGENT_SKILLS_MAX_ENTRIES),
    ...(truncated ? {truncated: true} : {}),
  };
}

// Apply the deployment's skill curation to a skill list: drop skills the admin has disabled.
// Applied at per-turn materialization, like removeDisabledSkillEntries below, so a curation change
// reaches existing chats on their next turn despite the cached snapshots.
export function removeDisabledSkills(
    list: AgentSkillList | null, disabledSkills: ReadonlySet<string>): AgentSkillList | null {
  if (!list || disabledSkills.size === 0) return list;
  let skills = list.skills.filter(skill => !disabledSkills.has(skill.name));
  if (skills.length === list.skills.length) return list;
  return {...list, skills};
}

// The <available_skills> system-prompt section (slot 1): the skills reachable this turn, in the
// agentskills.io XML shape, with instructions to load one via the loadSkill tool when a task
// matches. "" when there are no skills. Escaped because the names/descriptions are untrusted
// gatekeeper data being placed inside an XML-shaped block.
export function formatAvailableSkillsPrompt(skills: AgentSkillInfo[]): string {
  // Lists are deduplicated per resource (normalizeAgentSkillList), but a name can recur across
  // resources; keep the first, matching how loadSkill resolves a name to the first snapshot hit.
  let seen = new Set<string>();
  skills = skills.filter(skill => !seen.has(skill.name) && (seen.add(skill.name), true));
  if (skills.length === 0) return "";
  let lines = [
    "The following skills provide specialized instructions for specific tasks. When a task " +
        "matches a skill's description, call the loadSkill tool with the skill's name, then " +
        "follow the loaded instructions.",
    "",
    "<available_skills>",
  ];
  for (let skill of skills) {
    lines.push(
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        "  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
}

// Apply the deployment's skill curation to a catalog: drop entries marked as Agent Skills whose
// skill name (their title) the admin has disabled. Applied where cached catalog snapshots are
// materialized for a turn — not where they are loaded — so a curation change reaches existing
// chats on their next turn. Non-skill entries always pass.
export function removeDisabledSkillEntries(
    catalog: AgentCatalog | null, disabledSkills: ReadonlySet<string>): AgentCatalog | null {
  if (!catalog || disabledSkills.size === 0) return catalog;
  let entries = catalog.entries.filter(entry => !(entry.skill && disabledSkills.has(entry.title)));
  if (entries.length === catalog.entries.length) return catalog;
  return {...catalog, entries};
}

// The catalog as a JSON blob for inclusion in a prompt, on its own line, or "" if empty.
export function formatAgentCatalogPrompt(catalog: AgentCatalog | null): string {
  if (!catalog?.entries.length) return "";
  return `\n${JSON.stringify(catalog)}`;
}

// Build the system-prompt section that tells the agent which always-available resource bindings it
// has (their `env.NAME` entries) plus each one's discovery catalog, and how to use them. This
// describes the agent's environment rather than anything the user said, so it lives in the system
// prompt alongside the bindings list rather than as a synthetic user turn.
export function formatAlwaysAvailableResourcesPrompt(resources: Array<{
  title: string;
  name: string;
  catalog: AgentCatalog | null;
}>): string {
  let lines = resources.map(resource =>
    `- ${resource.title}: \`env.${resource.name}\`${formatAgentCatalogPrompt(resource.catalog)}`);
  return `The following resources are always available as bindings in your env for use with the ` +
    `executeCode tool (you don't need to request them):\n${lines.join("\n")}\n` +
    `When one is relevant, use describeBinding with the binding's name to learn its API before ` +
    `using it. If an App's persistent code needs one, wire it into that app with ` +
    `setGadgetBinding.`;
}
