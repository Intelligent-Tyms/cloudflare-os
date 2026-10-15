# gatekeeper-intelligence

Connects a tenant's **Organization Intelligence** wiki (an external MCP server on the Tyms
Intelligence cell, `https://<slug>.organization.tyms.ai`) to the workshop as an ambient capability.

Shape, in one line each:

- **Configured per tenant, like `gatekeeper-mcp-portal`.** `INTELLIGENCE_MCP_URL`,
  `INTELLIGENCE_WIKI_URL` (optional) and `INTELLIGENCE_ASSISTANT_KEY` (secret) live in the
  `VendorSetupStore` keyed by the tenant from the binding props. Admin → Intelligence writes them
  after provisioning through `applySetup`; an admin can also paste a console-minted `oik_` key.
  There is no deploy-time fallback.
- **Ambient, like `gatekeeper-scheduler`.** Once configured, `describe()` reports
  `autoProvisionsAccount`, the Workshop mints one `IntelligenceAccount` per user, and the account's
  singleton facet `IntelligenceGatekeeper` is installed into every workspace as the `INTELLIGENCE`
  binding. `providesUi.externalUrl` gives the sidebar a "Wiki" link that opens the wiki itself.
- **MCP through `@gadgets/mcp-shared`.** The facet is a stateless `McpFacetBase`: the key comes
  from the setup store on every call, scoped to the configured endpoint, and no session id is
  persisted. Trust is `vetted`: the wiki's own `readOnlyHint` tools (`search`, `read_page`,
  `list_pages`, `precedence_index`, `read_source`) run at once; `add_source` waits for approval.
- **Precedence in the system prompt.** `getAgentPromptContext()` fetches
  `GET /api/w/<wiki>/precedence?format=md` with the key, makes the index links absolute, prefixes
  the citation instruction, and caches the result in the facet for five minutes or until the setup
  store changes. The Workshop snapshots it once per chat, so a refresh reaches new chats only.

- **Same-zone reachability.** Wiki hosts are served by the cell Worker through routes on the
  zone this worker shares with them, and Cloudflare sends a same-zone subrequest to the DNS
  origin rather than to a Worker on a route. deploy.mjs binds the cell Worker as
  `INTELLIGENCE_CELL`, and `src/cell.ts` routes every request to a host under
  `INTELLIGENCE_BASE_DOMAIN` through it, URL unchanged.

Unconfigured (or after `clearSetup` on deprovision) the vendor advertises nothing, accounts declare
no singleton, and every call fails closed.

Tests run in Node (`vitest run`); nothing they import touches `cloudflare:workers`.
