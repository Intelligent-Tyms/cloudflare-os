// OKF (Open Knowledge Format) v0.2 frontmatter evaluation for Knowledge documents.
//
// Implements the Tyms profile: every markdown concept file gets a baseline check (parseable
// YAML frontmatter, non-empty `type`), and files in canonical collections additionally require
// `title`, `description`, `generated: { by, at }`, a non-empty `sources` list, and an explicit
// `status`. Evaluation never rejects a document (OKF tolerance rule) — callers surface the
// issues and the file is stored regardless.
//
// Pure and browser-safe so the management app can reuse it for live conformance hints.

import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "./description-extractors.js";
import { isMarkdownContentType, type OkfInfo } from "./context-types.js";

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

  return {
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
    issues,
    strictIssues,
  };
}
