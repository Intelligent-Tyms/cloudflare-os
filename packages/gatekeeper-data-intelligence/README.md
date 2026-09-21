# gatekeeper-data-intelligence

Connects a tenant's **Data Intelligence** organization (an external MCP server on the Tyms Data
Intelligence cell, `https://<slug>.data.tyms.ai/mcp`) to the workshop as an ambient capability, so
the assistant answers data questions from the tenant's own databases and uploaded files.

A sibling of `gatekeeper-intelligence` and deliberately the same shape, in one line each:

- **Configured per tenant.** `DATA_INTELLIGENCE_MCP_URL`, `DATA_INTELLIGENCE_CONSOLE_URL`
  (optional) and `DATA_INTELLIGENCE_ASSISTANT_KEY` (secret) live in the `VendorSetupStore` keyed
  by the tenant from the binding props. Admin → Intelligence writes them after provisioning
  through `applySetup` (the names are mirrored in `workshop-backend/src/intelligence-setup.ts`);
  an admin can also paste a console-minted `dik_` key. There is no deploy-time fallback.
- **Ambient.** Once configured, `describe()` reports `autoProvisionsAccount`, the Workshop mints
  one `DataIntelligenceAccount` per user, and the account's singleton facet
  `DataIntelligenceGatekeeper` is installed into every workspace as the `DATA_INTELLIGENCE`
  binding. `providesUi.externalUrl` gives the sidebar a "Data" link that opens the workbench.
- **MCP through `@gadgets/mcp-shared`.** The facet is a stateless `McpFacetBase`: the key comes
  from the setup store on every call, scoped to the configured endpoint, and no session id is
  persisted. Trust is `vetted`: the cell's own `readOnlyHint` tools (`list_connections`,
  `search_schema`, `describe_table`, `get_context`, `dry_run`, `run_sql`, `list_reports`,
  `read_report`, `list_uploads`, `read_upload`) run at once; `save_report`, the only tool that
  writes, waits for approval. What the key may read is decided in Data Intelligence (the key's
  connections, each connection's policy and masked columns), not here.
- **Who asked.** When the Workshop knows the person behind a session the facet sends a signed
  actor assertion as `x-tyms-actor`, so the cell's query log names the person, not just the key.
- **A fixed prompt block.** `getAgentPromptContext()` returns `src/prompt.ts`: when to use the
  binding and the order that produces correct SQL (`list_connections` → `get_context` →
  `dry_run` → `run_sql`). It reads nothing from the tenant, so there is no observation to
  authorize; the organization's own context reaches the agent through `get_context`.
- **Same-zone reachability.** Tenant hosts are served by the cell Worker through routes on the
  zone this worker shares with them, and Cloudflare sends a same-zone subrequest to the DNS
  origin rather than to a Worker on a route. deploy.mjs binds the cell Worker as
  `DATA_INTELLIGENCE_CELL`, and `src/cell.ts` routes every request to a host under
  `DATA_INTELLIGENCE_BASE_DOMAIN` through it, URL unchanged.

The vendor id is `data_intelligence`: the Workshop derives it from the binding name
(`GATEKEEPER_DATA_INTELLIGENCE`), as it does for `mcp_portal`.

Unconfigured (or after `clearSetup` on deprovision) the vendor advertises nothing, accounts declare
no singleton, and every call fails closed.

`VendorSetupStore` and `cell.ts` are copies of `gatekeeper-intelligence`'s; lifting the store into
`mcp-shared` is the follow-up its own comment already names.

Tests run in Node (`vitest run`); nothing they import touches `cloudflare:workers`.
