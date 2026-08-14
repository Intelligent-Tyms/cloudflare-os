// Builds the authoritative-context prompt block from canonical collections' system indexes
// (the Tyms OKF profile's precedence section). Pure functions; the gatekeeper calls them from
// getAgentPromptContext.

import { encodeDocId } from "./context-types.js";
import { splitFrontmatter } from "./description-extractors.js";

// Per-collection budget inside the Workshop's overall AGENT_PROMPT_CONTEXT_MAX_LENGTH cap, so one
// oversized folder can't crowd out the others.
export const COLLECTION_CONTEXT_MAX_CHARS = 6_000;

// Appended when a collection's index had to be cut.
const TRUNCATION_FOOTER = "\n\n(index truncated - search Knowledge for the rest)";

export type CanonicalIndex = {
  collectionId: string;
  title: string;
  // The collection's root index.md body, as stored (frontmatter included).
  indexBody: string;
};

// Rewrite the index's bundle-absolute entry links (`[name](/path)`, the shape
// generateIndexMarkdown emits) into citation URLs the chat UI can open. The model reproduces
// these links verbatim when citing, so it never constructs or encodes doc IDs itself.
export function rewriteIndexLinks(collectionId: string, body: string): string {
  return body.replace(/\]\(\/([^)]+)\)/g, (_match, path: string) =>
      `](/gatekeepers/context?p=${encodeURIComponent(encodeDocId(collectionId, path))})`);
}

// One collection's contribution: heading, then its index with frontmatter stripped (YAML noise
// spends tokens without informing the model) and links rewritten, clamped to the budget.
function collectionSection(index: CanonicalIndex): string {
  let { content } = splitFrontmatter(index.indexBody);
  let rewritten = rewriteIndexLinks(index.collectionId, content.trim());
  if (rewritten.length > COLLECTION_CONTEXT_MAX_CHARS) {
    rewritten = rewritten.slice(0, COLLECTION_CONTEXT_MAX_CHARS) + TRUNCATION_FOOTER;
  }
  return `## ${index.title}\n\n${rewritten}`;
}

// The full block: one section per canonical collection, deterministically ordered (title then id,
// matching catalog ordering) so the injected prompt is byte-stable for caching.
export function buildPromptContextBlock(indexes: CanonicalIndex[]): string {
  return indexes
      .toSorted((left, right) =>
          left.title.localeCompare(right.title) ||
          left.collectionId.localeCompare(right.collectionId))
      .map(collectionSection)
      .join("\n\n");
}
