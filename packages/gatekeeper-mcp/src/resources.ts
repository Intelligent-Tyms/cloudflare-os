import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";
import { catalogResource, type CatalogServer } from "./vetted-catalog.js";

const DESCRIPTION =
  "An MCP endpoint you supply. Tools are discovered automatically, and writes need approval.";

const HTTPS_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Any MCP server",
  description: DESCRIPTION,
};

const HTTP_RESOURCE: SupportedResource = { ...HTTPS_RESOURCE, urlPattern: "http://*" };

// Vetted catalog servers first (each grantable, keyed by its exact endpoint), then the
// bring-your-own catch-alls. The `https://*` entry must stay: the Workshop treats it as the
// whole-instance fallback for arbitrary URLs, which is exactly the BYO path.
export function mcpResources(allowInsecure: boolean, catalog: CatalogServer[] = []): SupportedResource[] {
  return [
    ...catalog.map(catalogResource),
    HTTPS_RESOURCE,
    ...(allowInsecure ? [HTTP_RESOURCE] : []),
  ];
}

// The SupportedResource a connected endpoint reports back as. A catalog member reports its own
// catalog entry so the account's granted pattern lines up with what the picker toggled; anything
// else falls back to the protocol catch-all.
export function mcpResourceFor(endpoint: string, catalog: CatalogServer[] = []): SupportedResource {
  const entry = catalog.find((server) => sameEndpoint(server.endpoint, endpoint));
  if (entry) return catalogResource(entry);
  return new URL(endpoint).protocol === "http:" ? HTTP_RESOURCE : HTTPS_RESOURCE;
}
