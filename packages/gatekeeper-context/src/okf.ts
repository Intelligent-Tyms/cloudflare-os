// OKF (Open Knowledge Format) v0.2 frontmatter evaluation for Knowledge documents.
//
// Implements the Tyms profile: every markdown concept file gets a baseline check (parseable
// YAML frontmatter, non-empty `type`), and files in canonical collections additionally require
// `title`, `description`, `generated: { by, at }`, a non-empty `sources` list, and an explicit
// `status`. Evaluation never rejects a document (OKF tolerance rule) — callers surface the
// issues and the file is stored regardless.
//
// Pure and browser-safe so the management app can reuse it for live conformance hints.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { splitFrontmatter } from "./description-extractors.js";
import { isMarkdownContentType, type OkfInfo, type OkfTier } from "./context-types.js";

// Lifecycle states the profile accepts. Anything else is treated as unset (and flagged for
// canonical files), not rejected.
export const OKF_STATUSES = ["draft", "stable", "deprecated"] as const;

// Reserved filenames are directory listings and history, not concept documents, at any level.
const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);

// Originals under a references/ directory are byte-preserved source material (any depth).
export function isUnderReferences(path: string): boolean {
  return path.split("/").slice(0, -1).includes("references");
}

// Whether a stored document is an OKF concept file subject to frontmatter evaluation. Only
// markdown carries frontmatter, so binaries and other text types are structurally exempt;
// references/ originals are exempt as source material.
export function isOkfConceptPath(path: string, contentType: string): boolean {
  if (!isMarkdownContentType(contentType)) return false;
  if (isUnderReferences(path)) return false;
  return !RESERVED_FILENAMES.has(path.split("/").at(-1)!);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// `at` survives as a string under YAML 1.2, but stay lenient about scalar types.
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

// Actor stamps are `{ by, at }` mappings (OKF trust family).
function isActorStamp(value: unknown): boolean {
  return isMapping(value) && nonEmptyString(value.by) && hasValue(value.at);
}

// Valid `verified` stamps, normalized. Accepts a bare mapping as a one-element list per OKF.
function parseVerified(value: unknown): { by: string; at: string }[] {
  let entries = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  return entries
      .filter(isActorStamp)
      .map(entry => {
        let stamp = entry as Record<string, unknown>;
        return { by: String(stamp.by).trim(), at: String(stamp.at) };
      });
}

// Human-grade actors per the Tyms profile: `human:<id>`, plus `account:<id>` until the Workshop's
// UI context carries a username (accounts are people; assistants and jobs use other prefixes).
const HUMAN_ACTOR_RE = /^(human|account):/;

// Trust tier per OKF §5.2, with the profile's invalidation rule: a verification attests to the
// content that was reviewed, so stamps older than the document's last content change don't count.
export function deriveOkfTier(
    verified: { by: string; at: string }[] | undefined,
    contentChangedAt: Date): OkfTier {
  let current = (verified ?? []).filter(stamp => {
    let at = Date.parse(stamp.at);
    return Number.isFinite(at) && at >= contentChangedAt.getTime();
  });
  if (current.some(stamp => HUMAN_ACTOR_RE.test(stamp.by))) return "human-reviewed";
  if (current.length > 0) return "machine-confirmed";
  return "unverified";
}

// Evaluate one markdown body. `issues` are OKF baseline problems; `strictIssues` only matter
// when the collection is canonical. Both empty means fully conformant.
export function evaluateOkf(body: string): OkfInfo {
  let issues: string[] = [];
  let strictIssues: string[] = [];

  let { frontmatter } = splitFrontmatter(body);
  let parsed: unknown;
  if (frontmatter === null) {
    issues.push("Missing YAML frontmatter.");
  } else {
    try {
      parsed = parseYaml(frontmatter);
    } catch {
      issues.push("Frontmatter is not valid YAML.");
    }
    if (parsed !== undefined && !isMapping(parsed)) {
      issues.push("Frontmatter must be a YAML mapping.");
    }
  }
  let fm = isMapping(parsed) ? parsed : undefined;

  let type = fm && nonEmptyString(fm.type) ? fm.type.trim() : undefined;
  if (fm && !type) issues.push("Missing required `type` field.");
  let title = fm && nonEmptyString(fm.title) ? fm.title.trim() : undefined;
  let description = fm && nonEmptyString(fm.description) ? fm.description.trim() : undefined;

  if (!nonEmptyString(fm?.title)) strictIssues.push("Canonical files require a `title`.");
  if (!nonEmptyString(fm?.description)) {
    strictIssues.push("Canonical files require a `description`.");
  }
  if (!isActorStamp(fm?.generated)) {
    strictIssues.push("Canonical files require `generated: { by, at }`.");
  }
  let sources = fm?.sources;
  if (!Array.isArray(sources) || sources.length === 0 ||
      !sources.every(entry => isMapping(entry) && hasValue(entry.resource))) {
    strictIssues.push("Canonical files require at least one `sources` entry with a `resource`.");
  }
  let rawStatus = fm && nonEmptyString(fm.status) ? fm.status.trim() : undefined;
  let status = OKF_STATUSES.find(known => known === rawStatus);
  if (!status) {
    strictIssues.push("Canonical files must set `status` explicitly (draft | stable | deprecated).");
  }

  let verified = parseVerified(fm?.verified);

  return {
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
    ...(verified.length > 0 ? { verified } : {}),
    issues,
    strictIssues,
  };
}

// Append a verification stamp to a concept file and promote a draft to stable. The frontmatter is
// re-serialized, so YAML comments are lost — acceptable at this point in the lifecycle, since the
// pack templates' guidance comments have served their purpose once a human confirms the content.
// Throws when the file has no parseable frontmatter mapping; callers gate on evaluateOkf first.
export function appendVerification(body: string, actor: string, at: Date): string {
  let { frontmatter, content } = splitFrontmatter(body);
  if (frontmatter === null) throw new Error("Cannot verify a file without frontmatter.");
  let parsed = parseYaml(frontmatter) as unknown;
  if (!isMapping(parsed)) throw new Error("Cannot verify a file without a frontmatter mapping.");

  let existing = parseVerified(parsed.verified);
  parsed.verified = [...existing, { by: actor, at: at.toISOString() }];
  if (parsed.status === "draft") parsed.status = "stable";

  let serialized = stringifyYaml(parsed).trimEnd();
  return `---\n${serialized}\n---\n\n${content.replace(/^\s*\n/, "")}`;
}
