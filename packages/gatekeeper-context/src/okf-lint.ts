// The OKF health pass for one canonical collection (the profile's lint section): deterministic
// bookkeeping checks whose findings land in the collection's log.md. Pure so every check is
// unit-testable; the collection DO runs it from a daily alarm.

import { parse as parseYaml } from "yaml";
import { evaluateOkf, isOkfConceptPath, isUnderReferences } from "./okf.js";
import { OKF_INDEX_PATH, OKF_LOG_PATH } from "./okf-system-files.js";
import { splitFrontmatter } from "./description-extractors.js";

// A draft older than this is worth chasing: someone started a fact and never verified it.
export const MAX_DRAFT_AGE_DAYS = 14;

// Cap on reported findings per run, so one messy folder doesn't flood its own log.
const MAX_FINDINGS = 30;

export type LintRecord = {
  path: string;
  contentType: string;
  body: string;
  lastUpdated: Date;
};

// Bundle-absolute links in a concept body (the shape the system index and pack files use).
const ABSOLUTE_LINK_RE = /\]\(\/([^)#?\s]+)\)/g;

function link(path: string): string {
  return `[${path}](/${path})`;
}

export function lintCollection(input: {
  records: LintRecord[];
  canonical: boolean;
  now: Date;
  // Bundled pack versions by pack id, to flag a seeded copy lagging the shipped pack.
  bundledPackVersions?: ReadonlyMap<string, number>;
}): string[] {
  let { records, canonical, now } = input;
  let findings: string[] = [];
  let paths = new Set(records.map(record => record.path));
  let conceptBodies: { path: string; body: string }[] = [];

  for (let record of records) {
    if (!isOkfConceptPath(record.path, record.contentType)) continue;
    conceptBodies.push({ path: record.path, body: record.body });
    let evaluation = evaluateOkf(record.body);

    let problems = [...evaluation.issues, ...(canonical ? evaluation.strictIssues : [])];
    if (problems.length > 0) {
      findings.push(`${link(record.path)}: ${problems[0]}`);
    }
    if (evaluation.status === "stable" && evaluation.staleAfter &&
        Date.parse(evaluation.staleAfter) < now.getTime()) {
      findings.push(`${link(record.path)}: stale since ${evaluation.staleAfter}; re-verify or update.`);
    }
    if (evaluation.status === "draft") {
      let ageDays = Math.floor((now.getTime() - record.lastUpdated.getTime()) / 86_400_000);
      if (ageDays > MAX_DRAFT_AGE_DAYS) {
        findings.push(`${link(record.path)}: draft for ${ageDays} days; finish and verify it.`);
      }
    }
    for (let match of record.body.matchAll(ABSOLUTE_LINK_RE)) {
      let target = match[1];
      let isDir = target.endsWith("/");
      let exists = isDir
          ? [...paths].some(path => path.startsWith(target))
          : paths.has(target);
      if (!exists) findings.push(`${link(record.path)}: broken link /${target}.`);
    }
  }

  // The mechanical half of ingest: an uploaded original nobody has written a concept file for.
  for (let record of records) {
    if (!isUnderReferences(record.path)) continue;
    let cited = conceptBodies.some(concept => concept.body.includes(record.path));
    if (!cited) {
      findings.push(`${link(record.path)}: no concept file cites this original yet.`);
    }
  }

  // Seeded copies flag themselves when the shipped pack has moved on (the accepted copy-drift
  // trade-off's detection path): the root index carries pack/pack_version through regeneration.
  let index = records.find(record => record.path === OKF_INDEX_PATH);
  if (index && input.bundledPackVersions?.size) {
    let { frontmatter } = splitFrontmatter(index.body);
    if (frontmatter !== null) {
      try {
        let parsed = parseYaml(frontmatter) as { pack?: unknown; pack_version?: unknown } | null;
        let pack = typeof parsed?.pack === "string" ? parsed.pack : undefined;
        let version = typeof parsed?.pack_version === "number" ? parsed.pack_version : undefined;
        let latest = pack !== undefined ? input.bundledPackVersions.get(pack) : undefined;
        if (pack && version !== undefined && latest !== undefined && latest > version) {
          findings.push(
              `This folder was seeded from the ${pack} pack v${version}; ` +
              `the deployment now ships v${latest}. Review what changed.`);
        }
      } catch {
        // Unparseable index frontmatter is already reported per-file above.
      }
    }
  }

  if (findings.length > MAX_FINDINGS) {
    let dropped = findings.length - MAX_FINDINGS;
    findings = [...findings.slice(0, MAX_FINDINGS), `and ${dropped} more.`];
  }
  return findings;
}
