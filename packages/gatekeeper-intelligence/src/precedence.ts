// The precedence index: the wiki's stable, human-reviewed pages as a markdown index, fetched with
// the assistant key and placed in the assistant's system prompt so the organization's recorded
// facts override whatever else the model knows. Pure functions; the facet calls them from
// `getAgentPromptContext`.

import { guardedFetch, readTextCapped, type FetchOptions } from "@gadgets/mcp-shared/fetch";
import type { IntelligenceConfig } from "./config.js";

/** Largest index body accepted from the wiki. The cell caps its own output well below this. */
export const MAX_PRECEDENCE_BYTES = 256 * 1024;

/**
 * Budget for the index inside the Workshop's `AGENT_PROMPT_CONTEXT_MAX_LENGTH` (16 384), leaving
 * headroom for the preamble so the instruction is never what gets cut.
 */
export const PRECEDENCE_CONTENT_MAX_CHARS = 14_000;

/** Appended when the index had to be cut. */
const TRUNCATION_FOOTER = "\n\n(index truncated - search the wiki for the rest)";

/** The wiki refused the assistant key: it was revoked, rotated, or the wiki is suspended. */
export class PrecedenceAuthError extends Error {
  constructor(status: number) {
    super(`The wiki refused the assistant key (${status}). Reconnect Organization Intelligence.`);
    this.name = "PrecedenceAuthError";
  }
}

/** Fetches the index markdown. Throws `PrecedenceAuthError` on 401/403/404 and a plain error otherwise. */
export async function fetchPrecedenceIndex(
  config: IntelligenceConfig, assistantKey: string, options: FetchOptions = {},
): Promise<string> {
  const response = await guardedFetch(config.precedenceUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${assistantKey}`,
      Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1",
    },
  }, options);
  // The cell answers 404 for a bad or foreign key (it never reveals whether a wiki exists), so a
  // 404 here means the key, not the URL.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new PrecedenceAuthError(response.status);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The wiki's precedence index is unavailable (${response.status}).`);
  }
  return readTextCapped(response, MAX_PRECEDENCE_BYTES);
}

// The cell emits the index with YAML frontmatter (`okf_version`, the wiki description). The
// description is useful; the rest spends tokens without informing the model.
function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return markdown;
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  const body = markdown.slice(match[0].length);
  return description ? `${unquote(description)}\n\n${body}` : body;
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

// Cut at a line boundary so a link is never left half-written for the model to complete.
function clampAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return text.slice(0, cut > max / 2 ? cut : max) + TRUNCATION_FOOTER;
}

/**
 * The index links pages by wiki-relative path (`[Title](/policies/expenses)`), the shape the wiki's
 * own index.md uses. The model reproduces links verbatim when citing, so they are made absolute
 * here and never constructed by the model.
 */
export function absolutizeIndexLinks(markdown: string, pageBaseUrl: string): string {
  return markdown.replace(/\]\((\/[^)\s]*)\)/g, (_match, path: string) => `](${pageBaseUrl}${path})`);
}

/**
 * The prompt block: an instruction on how the index is to be used and cited, then the index
 * itself in the order the wiki emitted it. The order is left alone on purpose: the wiki sorts
 * deterministically, so the block is byte-stable between fetches and the provider's prompt cache
 * keeps it.
 */
export function buildIntelligencePromptContext(
  markdown: string, config: Pick<IntelligenceConfig, "wikiUrl" | "pageBaseUrl">,
): string {
  const preamble =
    `These are the organization's recorded precedents from its wiki at ${config.wikiUrl}. Every ` +
    "page listed here is human-reviewed and overrides your own knowledge and other sources. When " +
    "you rely on one, cite it inline exactly as `[Title · human-reviewed](url)` using the link from " +
    "this index; for pages found through the wiki's tools, use the title, tier and url from the " +
    "result's `citations`. Never invent a URL. For any question about the organization, search " +
    "the wiki before answering.";
  const body = clampAtLine(
    absolutizeIndexLinks(stripFrontmatter(markdown).trim(), config.pageBaseUrl),
    PRECEDENCE_CONTENT_MAX_CHARS);
  return body ? `${preamble}\n\n${body}` : preamble;
}
