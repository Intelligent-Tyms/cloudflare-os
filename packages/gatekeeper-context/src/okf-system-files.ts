// Generators for the system-maintained OKF reserved files: the collection root's index.md
// (directory listing, regenerated on every mutation) and log.md (append-only change history).
// Pure functions; the collection DO calls them inside its write transactions.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { splitFrontmatter } from "./description-extractors.js";

export const OKF_INDEX_PATH = "index.md";
export const OKF_LOG_PATH = "log.md";

// Keep the log comfortably under MAX_DOCUMENT_BODY_BYTES; oldest date sections drop first.
export const LOG_MAX_BYTES = 262_144;

// Heading for entries whose frontmatter declares no type.
const UNTYPED_HEADING = "Files";

export type IndexEntry = {
  path: string;
  // Display name: the concept's frontmatter title, else its file name.
  name: string;
  type?: string;
  description?: string;
  // Canonical folders only: the entry does not meet the precedence bar (stable + human-reviewed),
  // so the index marks it and readers know it never overrides.
  pendingReview?: boolean;
};

export type LogEvent = {
  at: Date;
  action: "Creation" | "Update" | "Deletion" | "Move" | "Verification" | "Lint";
  // Markdown fragment naming what changed, e.g. "[a.md](/a.md)" or "[a.md](/a.md) → [b.md](/b.md)".
  detail: string;
  actor?: string;
};

// Regenerate the root index.md body. Unknown frontmatter keys of the existing index (e.g. a
// seeded pack's `pack`/`pack_version`) are preserved per OKF round-tripping; okf_version is
// pinned. Entries are grouped by type, sorted, untyped entries last.
export function generateIndexMarkdown(
    meta: { description: string },
    entries: IndexEntry[],
    existingBody?: string): string {
  let carried: Record<string, unknown> = {};
  if (existingBody) {
    let { frontmatter } = splitFrontmatter(existingBody);
    if (frontmatter !== null) {
      try {
        let parsed = parseYaml(frontmatter) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          carried = parsed as Record<string, unknown>;
        }
      } catch {
        // A malformed existing block is dropped: the regenerated file must stay valid.
      }
    }
  }
  let frontmatterYaml = stringifyYaml({ ...carried, okf_version: "0.2" }).trimEnd();

  let groups = new Map<string, IndexEntry[]>();
  for (let entry of entries) {
    let heading = entry.type?.trim() || UNTYPED_HEADING;
    let group = groups.get(heading);
    if (group) group.push(entry);
    else groups.set(heading, [entry]);
  }
  let headings = [...groups.keys()].sort((a, b) =>
      a === UNTYPED_HEADING ? 1 : b === UNTYPED_HEADING ? -1 : a.localeCompare(b));

  let sections = headings.map(heading => {
    let lines = groups.get(heading)!
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(e => `* [${e.name}](/${e.path})${e.description ? ` - ${e.description}` : ""}${
            e.pendingReview ? " (pending review; does not override)" : ""}`);
    return `# ${heading}\n${lines.join("\n")}`;
  });

  let intro = meta.description ? `${meta.description}\n\n` : "";
  return `---\n${frontmatterYaml}\n---\n\n${intro}${sections.join("\n\n")}\n`;
}

// Append one event to the log, newest first, grouped by ISO date per OKF. The header carries the
// collection title so seeded pack logs ("# Company Update Log") integrate seamlessly; an existing
// body under a different header is preserved below the new entries rather than clobbered.
export function appendLogEntry(
    existingBody: string | undefined,
    collectionTitle: string,
    event: LogEvent,
    maxBytes: number = LOG_MAX_BYTES): string {
  let header = `# ${collectionTitle} Update Log`;
  let date = event.at.toISOString().slice(0, 10);
  let line = `* **${event.action}**: ${event.detail}${event.actor ? ` by ${event.actor}` : ""}.`;

  let body = existingBody?.trim() ?? "";
  let rest: string;
  if (body.startsWith(header)) {
    rest = body.slice(header.length).replace(/^\n+/, "");
  } else {
    // Foreign or renamed-title log: keep it intact below our entries.
    rest = body;
  }

  let dateHeading = `## ${date}`;
  if (rest.startsWith(dateHeading)) {
    rest = `${dateHeading}\n${line}${rest.slice(dateHeading.length)}`;
  } else {
    rest = `${dateHeading}\n${line}${rest ? `\n\n${rest}` : ""}`;
  }
  let updated = `${header}\n\n${rest}`;

  // Size cap: drop the oldest date sections until the log fits.
  let encoder = new TextEncoder();
  while (encoder.encode(updated).length > maxBytes) {
    let cut = updated.lastIndexOf("\n## ");
    if (cut <= header.length) break;
    updated = updated.slice(0, cut).trimEnd();
  }
  return `${updated}\n`;
}
