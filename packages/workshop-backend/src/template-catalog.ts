// The fleet's template catalog: app templates curated centrally (TEMPLATE_CATALOG_URL, served
// by the control plane) and installed into this deployment on demand, the first time anyone
// opens one, instead of being bundled into the Worker and installed on first contact.
//
// Everything here treats the catalog as external input: shape-checked and clamped before use,
// and the files pass through the same archive reader an uploaded blueprint does. Installed
// templates are ordinary blueprints (KV metadata + R2 snapshot) exactly like bundled formats;
// nothing downstream knows where they came from. A template a tenant already holds is
// reinstalled when the catalog's `revision` is higher, which is the same rule bundled formats
// always used: authors bump `revision` to reach installed tenants.

import * as Y from "yjs";
import { AiChatAuthorInfo, BlueprintMetadata, BlueprintOutput, BlueprintPublicInfo } from "@gadgets/workshop-shared/api";
import { BlueprintKvEnv, BlueprintKvRecord, buildBlueprintArchiveStream, listFeaturedBlueprintsFromKv, readBlueprintKvRecord, sanitizeBlueprintOutput } from "./blueprint-archive.js";
import { isPoolMode } from "./pool-mode.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.templates");

export type CatalogEnv = Pick<Cloudflare.Env, "TEMPLATE_CATALOG_URL" | "POOL_MODE">;

/** One catalog entry, as the deployment offers it before (or without) installing it. */
export type CatalogTemplate = {
  id: string;
  title: string;
  description: string;
  author: AiChatAuthorInfo;
  output?: BlueprintOutput;
  revision: number;
  created: Date;
};

const ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_CATALOG_ENTRIES = 50;
const CATALOG_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// Bounds on one template's files, mirroring the catalog's own (control plane src/templates.ts).
const MAX_FILES = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

// Per isolate: the catalog is read on every Apps page load and blueprint open, so it is cached
// briefly and served stale when a refresh fails — a flaky control plane must not blank the page.
let catalogCache: { entries: CatalogTemplate[]; expiresAt: number } | undefined;

function catalogBase(env: CatalogEnv): string | null {
  let base = env.TEMPLATE_CATALOG_URL?.trim();
  return base ? base.replace(/\/$/, "") : null;
}

async function fetchCatalogJson(env: CatalogEnv, path: string): Promise<unknown> {
  let base = catalogBase(env);
  if (!base) throw new Error("This deployment has no template catalog configured.");
  let response = await fetch(`${base}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The template catalog responded with status ${response.status}.`);
  }
  return await response.json();
}

function parseAuthor(value: unknown): AiChatAuthorInfo | null {
  let { name, id } = (value ?? {}) as Partial<AiChatAuthorInfo>;
  if (typeof name !== "string" || !name.trim() || typeof id !== "string" || !id.trim()) return null;
  return { type: "user", name: name.trim().slice(0, 120), id: id.trim().slice(0, 200) };
}

/** One catalog row or package manifest, or null when it is not usable. Exported for tests. */
export function parseCatalogTemplate(item: unknown): CatalogTemplate | null {
  let { id, blueprintId, title, description, author, output, revision, created } =
      (item ?? {}) as Record<string, unknown>;
  let key = typeof id === "string" ? id : blueprintId;
  if (typeof key !== "string" || !ID_PATTERN.test(key)) return null;
  if (typeof title !== "string" || !title.trim()) return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  let parsedAuthor = parseAuthor(author);
  if (!parsedAuthor) return null;
  let createdDate = typeof created === "string" ? new Date(created) : new Date(NaN);
  if (Number.isNaN(createdDate.getTime())) return null;
  return {
    id: key,
    title: title.trim().slice(0, 120),
    description: (typeof description === "string" ? description : "").slice(0, 2048),
    author: parsedAuthor,
    output: sanitizeBlueprintOutput(output),
    revision,
    created: createdDate,
  };
}

/**
 * The catalog, or [] when this deployment has none (no URL, or a pool — pools offer no
 * templates). Malformed entries are dropped rather than failing the caller.
 */
export async function listTemplateCatalog(env: CatalogEnv): Promise<CatalogTemplate[]> {
  if (!catalogBase(env) || isPoolMode(env)) return [];
  if (catalogCache && Date.now() < catalogCache.expiresAt) return catalogCache.entries;
  try {
    let raw = await fetchCatalogJson(env, "");
    let list = (raw as { templates?: unknown })?.templates;
    if (!Array.isArray(list)) throw new Error("The template catalog returned an invalid list.");
    let entries: CatalogTemplate[] = [];
    for (let item of list) {
      let entry = parseCatalogTemplate(item);
      if (entry && !entries.some(e => e.id === entry.id)) entries.push(entry);
      if (entries.length >= MAX_CATALOG_ENTRIES) break;
    }
    catalogCache = { entries, expiresAt: Date.now() + CATALOG_TTL_MS };
    return entries;
  } catch (err) {
    logger.warn("failed to fetch the template catalog", {
      event: "templates.catalog.fetch.failed", error: err,
    });
    if (catalogCache) {
      catalogCache.expiresAt = Date.now() + CATALOG_TTL_MS;
      return catalogCache.entries;
    }
    return [];
  }
}

/** The metadata an installed copy of this entry carries; also what listings show pre-install. */
export function catalogMetadata(entry: CatalogTemplate): BlueprintMetadata {
  return {
    title: entry.title,
    description: entry.description,
    author: entry.author,
    created: entry.created,
    version: entry.revision,
    lastUpdated: entry.created,
    ...(entry.output ? { output: entry.output } : {}),
    bindings: {},
  };
}

/**
 * The featured list every listing shows: what this deployment has installed and featured, plus
 * every catalog template it has not installed yet, so a template is offered before its first
 * install. An installed entry wins over the catalog's copy of the same id.
 */
export async function listFeaturedWithCatalog(env: BlueprintKvEnv & CatalogEnv)
    : Promise<BlueprintPublicInfo[]> {
  let [featured, catalog] = await Promise.all([
    listFeaturedBlueprintsFromKv(env),
    listTemplateCatalog(env),
  ]);
  let seen = new Set(featured.map(entry => entry.id));
  for (let entry of catalog) {
    if (seen.has(entry.id)) continue;
    featured.push({ id: entry.id, metadata: catalogMetadata(entry) });
  }
  return featured;
}

/** A fetched package: the manifest plus the flat filename -> text map. */
export type CatalogPackage = { entry: CatalogTemplate; files: Record<string, string> };

/** Validate a package payload against the shared bounds. Exported for tests. */
export function parseCatalogPackage(raw: unknown): CatalogPackage {
  let { manifest, files } = (raw ?? {}) as { manifest?: unknown; files?: unknown };
  let entry = parseCatalogTemplate(manifest);
  if (!entry) throw new Error("The template catalog returned an invalid manifest.");
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("The template catalog returned an invalid package.");
  }
  // Null prototype so a hostile filename like "__proto__" is an ordinary key.
  let out: Record<string, string> = Object.create(null);
  let encoder = new TextEncoder();
  let total = 0;
  let count = 0;
  for (let [name, content] of Object.entries(files as Record<string, unknown>)) {
    if (typeof content !== "string" || !name || name.includes("/") || name.includes("\\") ||
        name === "." || name === "..") {
      throw new Error(`The template catalog returned an invalid file: ${name}.`);
    }
    let bytes = encoder.encode(content).length;
    total += bytes;
    count += 1;
    if (bytes > MAX_FILE_BYTES || count > MAX_FILES || total > MAX_TOTAL_BYTES) {
      throw new Error("The template exceeds the size limits.");
    }
    out[name] = content;
  }
  for (let required of ["server.js", "client.js"]) {
    if (!(required in out)) throw new Error(`The template has no ${required}.`);
  }
  return { entry, files: out };
}

/**
 * Pack files into a `.gadget` archive the way packages/app-templates/scripts/pack.mjs does: the
 * unnamed root map, filename -> Y.Text, as a gzipped Yjs V2 snapshot behind the archive prefix.
 * The client id is pinned so the same files always produce the same bytes.
 */
export async function buildTemplateArchive(metadata: BlueprintMetadata, files: Record<string, string>)
    : Promise<Uint8Array> {
  let doc = new Y.Doc();
  doc.clientID = 1;
  let rootMap = doc.getMap<Y.Text>("");
  doc.transact(() => {
    for (let name of Object.keys(files).toSorted()) {
      let text = new Y.Text();
      text.insert(0, files[name]);
      rootMap.set(name, text);
    }
  });
  let update = Y.encodeStateAsUpdateV2(doc);
  let compressed = new Uint8Array(await new Response(
      new Response(update as BufferSource).body!.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());
  let archive = buildBlueprintArchiveStream(
      metadata, new Response(compressed as BufferSource).body!, compressed.byteLength);
  return new Uint8Array(await new Response(archive).arrayBuffer());
}

/** Fetch one template's package from the catalog. */
export async function fetchCatalogPackage(env: CatalogEnv, id: string): Promise<CatalogPackage> {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid template id.");
  let pkg = parseCatalogPackage(await fetchCatalogJson(env, `/${encodeURIComponent(id)}/package`));
  if (pkg.entry.id !== id) throw new Error("The template catalog returned the wrong template.");
  return pkg;
}

/** The one call the installer exposes; lives on the AdminSettings DO so installs coalesce. */
export type CatalogInstaller = {
  AdminSettings: {
    getByName(name: string): { installCatalogTemplate(id: string): Promise<BlueprintPublicInfo> };
  };
};

/**
 * Read a blueprint, installing or upgrading it from the catalog first when the catalog offers
 * it and this deployment either lacks it or holds an older revision. Every read path that can
 * be reached with a template id goes through here, so a template is installed by whichever
 * request first needs it — a landing page visit, the New menu, or the agent — and nothing has
 * to pre-install on deploy.
 */
export async function readBlueprintKvRecordViaCatalog(
    env: BlueprintKvEnv & CatalogEnv, installer: CatalogInstaller, id: string)
    : Promise<BlueprintKvRecord | null> {
  let record = await readBlueprintKvRecord(env, id);
  if (!ID_PATTERN.test(id) || !catalogBase(env) || isPoolMode(env)) return record;
  let entry = (await listTemplateCatalog(env)).find(e => e.id === id);
  if (!entry) return record;
  if (record && record.metadata.version >= entry.revision) return record;
  try {
    await installer.AdminSettings.getByName("").installCatalogTemplate(id);
  } catch (err) {
    logger.error("failed to install a catalog template", {
      event: "templates.catalog.install.failed", blueprintId: id, error: err,
    });
    // An older installed copy beats nothing; a missing one surfaces as not found.
    return record;
  }
  return await readBlueprintKvRecord(env, id);
}
