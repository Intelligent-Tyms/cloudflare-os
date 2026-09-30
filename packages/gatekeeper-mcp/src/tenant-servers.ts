// Servers a tenant's administrator added for the company.
//
// The deployment's catalog (vetted-catalog.ts) is curated centrally and is the same for every
// tenant. A tenant also needs servers nobody curated: its own internal MCP endpoint, or a vendor
// the catalog does not list yet. Those used to be reachable only by each person pasting the URL
// and a key into their own connect page, which left every such connection personal and every
// workspace bound to one owner-only. Here the administrator adds the server once, with the
// company's key or none, and it behaves like any company server in the catalog: every member
// reaches it through the provisioned account, no one signs in, and a shared workspace opens for
// any member.
//
// Only servers that take a key or nothing can be added this way. A server that needs each person
// to sign in has no company credential to enter, so it stays a catalog matter.
//
// A tenant's entries live in its VendorSetupStore beside its keys. This module is the pure half:
// the record shape, its validation, and the merge with the central catalog.
import { sameEndpoint } from "@gadgets/mcp-shared/scope";
import type { VendorSetupInput } from "@gadgets/workshop-shared/gatekeeper";
import type { CatalogServer } from "./vetted-catalog.js";

export type TenantServer = {
  id: string;
  name: string;
  endpoint: string;
  /** A company key sent as a bearer token, or nothing. */
  auth: "token" | "none";
  addedAt: number;
};

export const MAX_TENANT_SERVERS = 12;
const MAX_NAME = 80;

/**
 * The setup inputs that add a server. They are a form, not stored configuration: applying them
 * creates a TenantServer, and they read back empty so the next server can be added.
 */
export const NEW_SERVER_NAME = "NEW_SERVER_NAME";
export const NEW_SERVER_URL = "NEW_SERVER_URL";
export const NEW_SERVER_KEY = "NEW_SERVER_KEY";

// Tenant ids carry this prefix so neither the id nor the key stored under it can ever be taken
// for a central catalog entry's, whatever the catalog lists later.
const ID_PREFIX = "custom-";
const ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]{0,47}$/;

/** The setup-store name under which a tenant server is listed, and by which it is removed. */
export function serverInputName(serverId: string): string {
  return `SERVER_${serverId.toUpperCase().replace(/-/g, "_")}`;
}

/** A stable id for a new server, from its name, distinct from every id in `taken`. */
export function tenantServerId(name: string, taken: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    .replace(/-+$/g, "") || "server";
  let id = `${ID_PREFIX}${slug}`;
  for (let n = 2; taken.has(id); n++) id = `${ID_PREFIX}${slug}-${n}`;
  return id;
}

/** The name an administrator typed, checked. */
export function validateServerName(input: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "Give the server a name your team will recognise." };
  if (name.length > MAX_NAME) return { ok: false, reason: `Keep the name under ${MAX_NAME} characters.` };
  return { ok: true, name };
}

/**
 * Reads stored records defensively: they are this worker's own writes, but they are read on
 * every listing, so one that does not parse is dropped rather than allowed to break the tenant's
 * connectors.
 */
export function parseTenantServers(raw: unknown): TenantServer[] {
  if (!Array.isArray(raw)) return [];
  const servers: TenantServer[] = [];
  for (const row of raw) {
    const record = row as Record<string, unknown>;
    if (typeof record?.id !== "string" || !ID_PATTERN.test(record.id)) continue;
    if (typeof record.name !== "string" || !record.name) continue;
    if (typeof record.endpoint !== "string" || !URL.canParse(record.endpoint)) continue;
    servers.push({
      id: record.id,
      name: record.name,
      endpoint: record.endpoint,
      auth: record.auth === "token" ? "token" : "none",
      addedAt: typeof record.addedAt === "number" ? record.addedAt : 0,
    });
    if (servers.length >= MAX_TENANT_SERVERS) break;
  }
  return servers;
}

/**
 * A tenant server as a catalog entry: the company's, shared by membership, and never vetted, so
 * nothing it calls a write is ever applied without approval.
 */
export function asCatalogServer(server: TenantServer): CatalogServer {
  return {
    id: server.id,
    name: server.name,
    description: "Added for the whole company by an administrator.",
    endpoint: server.endpoint,
    vetted: false,
    sharing: "public",
    auth: server.auth,
    credential: "organization",
    keyLabel: `${server.name} API key`,
    custom: true,
  };
}

/**
 * The catalog one tenant sees: the central catalog, then the tenant's own servers. The central
 * catalog wins a collision, by id or by endpoint, so curating a server later takes over from a
 * tenant's copy rather than listing it twice; the tenant's key is stored under its own id and is
 * never sent on the central entry's behalf.
 */
export function mergeCatalog(central: CatalogServer[], tenant: TenantServer[]): CatalogServer[] {
  const merged = [...central];
  for (const server of tenant) {
    if (merged.some((entry) => entry.id === server.id || sameEndpoint(entry.endpoint, server.endpoint))) {
      continue;
    }
    merged.push(asCatalogServer(server));
  }
  return merged;
}

/** The inputs of the form that adds a server. */
export function newServerInputs(): VendorSetupInput[] {
  return [
    {
      name: NEW_SERVER_NAME,
      kind: "var",
      label: "Name",
      setupSteps: [
        "Name the server and paste its MCP endpoint URL (it starts with https://).",
        "If the server needs an API key, paste the company's key. It is stored in this connector and sent only to that server, as a bearer token.",
        "Add it. The server becomes a connector everyone on the team can use without signing in, and anything that writes still waits for approval.",
      ],
    },
    { name: NEW_SERVER_URL, kind: "var", label: "Server URL" },
    { name: NEW_SERVER_KEY, kind: "secret", label: "API key", optional: true },
  ];
}
