// The prompt block the facet contributes (see `getAgentPromptContext`). It is fixed text: how the
// binding is meant to be used, in the order that produces correct SQL. Kept free of
// `cloudflare:workers` so it can be tested in Node.

/**
 * Says when to reach for Data Intelligence and how. The order matters more than the wording:
 * `get_context` carries the organization's own notes, verified queries and the engine hints (a
 * files connection is SQLite and reads offset timestamps in UTC), and SQL written without it is
 * the usual way an answer comes out plausible and wrong.
 */
export const DATA_INTELLIGENCE_PROMPT_CONTEXT =
  "This workspace has Data Intelligence: governed, read-only SQL over the organization's own " +
  "databases and uploaded files. Use it for any question about the organization's numbers " +
  "(customers, orders, revenue, usage, operations) instead of estimating or asking the person to " +
  "paste data.\n\n" +
  "How to answer a data question:\n" +
  "1. `list_connections` to see what exists; every other tool takes a connection id from it.\n" +
  "2. `get_context` with the person's question, before writing any SQL. It returns the relevant " +
  "tables and columns, the organization's notes and glossary, saved queries (prefer a verified " +
  "one over writing your own), and hints on the SQL dialect. Follow the hints. Use " +
  "`search_schema` or `describe_table` only when the packet is not enough.\n" +
  "3. `dry_run` the statement, then `run_sql`. One read-only statement at a time; writes are " +
  "refused. Results are bounded, so aggregate in SQL rather than fetching rows to add up, and " +
  "say so when a result comes back `truncated`.\n\n" +
  "Report numbers exactly as returned and name the connection and tables they came from. A " +
  "masked value (`***`) is withheld on purpose; do not try to recover it. If the organization's " +
  "notes define a term (for example what counts as an active customer), use that definition and " +
  "say which one you used. When asked for a report people can reopen, draft it with " +
  "`save_report`; it waits for approval.";
