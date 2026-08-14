// One collection's metadata and documents. Metadata changes update the private owner library or the
// public domain registry.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextPutResult,
  ContextGitTokenCreateResult, ContextGitTokenList,
  DEFAULT_DOCUMENT_CONTENT_TYPE, DEFAULT_GIT_BRANCH, MAX_DOCUMENT_BODY_BYTES,
  contentTypeFromPath, isTextContentType, OkfInfo, VENDOR_ID,
} from "./context-types.js";
import {
  appendVerification, deriveOkfTier, evaluateOkf, isOkfConceptPath, isUnderReferences,
  removeVerification,
} from "./okf.js";
import {
  appendLogEntry, generateIndexMarkdown, IndexEntry, LogEvent,
  OKF_INDEX_PATH, OKF_LOG_PATH,
} from "./okf-system-files.js";
import { lintCollection } from "./okf-lint.js";
import { KNOWLEDGE_PACKS } from "./generated/knowledge-packs.js";
import { metadataToSummary } from "./collection-kv.js";
import { domainName } from "./domain.js";
import { readArtifactRepoDocuments } from "./artifact-sync.js";
import {
  convertStoredDocumentToMarkdown, isConvertibleDocumentContentType,
} from "./document-conversion.js";
import {
  isSkillManifestPath, parseSkillManifest, type SkillIndexEntry,
} from "./agent-skill.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

const MAX_DOCUMENT_PATH_LENGTH = 1024;
// Git tokens created through the web UI are valid for one year,
// the maximum TTL supported by Artifacts.
const GIT_TOKEN_TTL_SECONDS = 31_536_000;
// Background git refresh happens minutely at most.
const GIT_REFRESH_MIN_INTERVAL_MS = 60_000;
// Allow simple branch names made of alphanumerics, '/', '.', '_', and '-', but not leading/trailing '/'.
const GIT_BRANCH_RE = /^(?!\/)(?!.*\/$)[A-Za-z0-9/._-]{1,255}$/;
// Older collections build this path list on first use. Increase the version when parsing rules
// change.
const SKILL_INDEX_VERSION = 1;

// Canonical collections run the OKF health pass (okf-lint.ts) on a daily alarm, armed on the
// canonical grant and re-armed after each run and mutation.
const LINT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Validate a document path before using it as a storage key.
function validateDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

// Last path segment; document names derive from paths.
function baseName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// Lowercased file extension (without the dot), or "" if none.
function extOf(path: string): string {
  let b = baseName(path);
  let i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

type ContextRecord = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  body: string;
  // Derived text for convertible binary documents (see document-conversion.ts). Regenerated on
  // every write; never edited, so it cannot diverge from `body`.
  extractedText?: string;
  lastUpdated: Date;
};

// Old records that predate git-based collections won't have `content` set in storage.
// Unset `content` is defaulted to { "source": "web" } at the API layer, which is why
// we have different types for storage vs. API interface.
type StoredContextCollectionMetadata = Omit<ContextCollectionMetadata, "content"> & {
  content?: ContextCollectionContent;
};

function makeContextCollectionStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      documents: collection<ContextRecord>()({ primaryKey: "path" }),
      // Data needed to list skills without loading document bodies.
      skillIndex: collection<SkillIndexEntry>()({ primaryKey: "path" }),
    },
    singletons: {
      // Sharing domain for cross-DO references.
      sharingDomain: "",
      // Private owner account id; empty for public collections.
      ownerAccountId: "",
      metadata: <StoredContextCollectionMetadata>{
        id: "",
        title: "",
        description: "",
        visibility: "private" as ContextCollectionVisibility,
        created: new Date(0),
        lastUpdated: new Date(0),
        documentCount: 0,
        content: { source: "web" },
      },
      skillIndexVersion: 0,
    },
  });
}

type ContextCollectionStorage = ReturnType<typeof makeContextCollectionStorage>;

export class ContextCollectionDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ContextCollectionStorage;
  // Set when an artifact refresh operation is in flight. Additional refresh requests should
  // await this promise when set instead of kicking off additional concurrent refreshes.
  #artifactRefresh?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeContextCollectionStorage(ctx.storage);
  }

  // Sharing domain for all cross-DO/KV references.
  #domain(): string {
    return this.storage.sharingDomain.get();
  }

  // The owner's UserLibraryDurableObject (private collections only), within this collection's domain.
  #ownerLibrary() {
    let ns = this.ctx.exports.UserLibraryDurableObject;
    return ns.get(ns.idFromName(domainName(this.#domain(), this.storage.ownerAccountId.get())));
  }

  #registry() {
    let ns = this.ctx.exports.LibraryRegistryDurableObject;
    return ns.getByName(this.#domain());
  }

  #artifacts(): Artifacts {
    let artifacts = this.env.ARTIFACTS;
    if (!artifacts) throw new Error("Git-backed Context collections are not enabled.");
    return artifacts;
  }

  async #createArtifactRepo(metadata: ContextCollectionMetadata): Promise<string> {
    // Artifact repo id is always set to collection id.
    let artifacts = this.#artifacts();
    let created = await artifacts.create(metadata.id, {
      setDefaultBranch: DEFAULT_GIT_BRANCH,
    });

    let repo = await artifacts.get(metadata.id);
    // Artifacts auto-creates an initial write token when the repo is first
    // created. We don't want or need this token, so we immediately revoke it.
    await repo.revokeToken(created.token).catch((err) => {
      logger.warn("failed to revoke initial Artifacts token for context collection", {
        event: "artifacts.initial.token.revoke.failed",
        collectionId: metadata.id,
        error: err,
      });
    });
    return created.remote;
  }

  // Initialize a new collection. Private collections pass an owner; public collections pass "".
  // Rejects re-initialization so a (vanishingly unlikely) id reuse can't clobber existing content.
  async initialize(metadata: ContextCollectionMetadata, sharingDomain: string, ownerAccountId: string): Promise<ContextCollectionMetadata> {
    if (this.getMetadata().id) {
      throw new Error("Collection already exists.");
    }
    // A collection can never be born canonical: the mark is granted post-creation by a
    // deployment admin (setCanonical), so no creation path can self-assert authority.
    delete metadata.canonical;
    this.storage.sharingDomain.put(sharingDomain);
    this.storage.ownerAccountId.put(ownerAccountId);
    if (metadata.content.source === "git") {
      metadata.content = {
        source: "git",
        remote: await this.#createArtifactRepo(metadata),
        branch: metadata.content.branch,
        lastRefreshedAt: metadata.created,
      };
    }
    this.storage.metadata.put(metadata);
    // A new collection starts with an up-to-date empty path list.
    this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    return metadata;
  }

  getMetadata(): ContextCollectionMetadata {
    let meta = this.storage.metadata.get();
    // Old storage records won't have `content` set, so we need to default these values in
    // at the API layer.
    return { ...meta, content: meta.content ?? { source: "web" } };
  }

  #parseAgentSkill(record: ContextRecord) {
    if (!isSkillManifestPath(record.path) ||
        !isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE)) {
      return undefined;
    }
    try {
      return parseSkillManifest(record.path, record.body);
    } catch {
      return undefined;
    }
  }

  // OKF conformance for concept files, derived on demand like #parseAgentSkill. Undefined for
  // non-concept files (binaries, references/ originals, reserved index.md/log.md). The tier is
  // judged against the record's last update, so any edit outdates prior verification.
  #parseOkf(record: ContextRecord): OkfInfo | undefined {
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    if (!isOkfConceptPath(record.path, contentType)) return undefined;
    let okf = evaluateOkf(record.body);
    return { ...okf, tier: deriveOkfTier(okf.verified, record.lastUpdated) };
  }

  // Update the skill entry after saving a document.
  #updateSkillIndex(record: ContextRecord): void {
    let manifest = this.#parseAgentSkill(record);
    if (manifest) {
      this.storage.skillIndex.put({
        path: record.path,
        skillName: manifest.name,
        description: manifest.description,
      });
    } else {
      this.storage.skillIndex.delete(record.path);
    }
  }

  // Save a document and update its skill entry together.
  #putDocument(record: ContextRecord): void {
    this.storage.documents.put(record);
    this.#updateSkillIndex(record);
  }

  // Delete a document and its skill entry together.
  #deleteDocument(path: string): void {
    this.storage.documents.delete(path);
    this.storage.skillIndex.delete(path);
  }

  #clearSkillIndex(): void {
    // Read the entries before deleting from the same storage collection.
    for (let entry of Array.from(this.storage.skillIndex.list())) {
      this.storage.skillIndex.delete(entry.path);
    }
  }

  // Build the index for collections created before it existed.
  #ensureSkillIndex(): void {
    if (this.storage.skillIndexVersion.get() === SKILL_INDEX_VERSION) return;

    let entries: SkillIndexEntry[] = [];
    for (let record of this.storage.documents.list()) {
      let manifest = this.#parseAgentSkill(record);
      if (manifest) {
        entries.push({
          path: record.path,
          skillName: manifest.name,
          description: manifest.description,
        });
      }
    }

    this.storage.transaction(() => {
      this.#clearSkillIndex();
      for (let entry of entries) {
        this.storage.skillIndex.put(entry);
      }
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  listAgentSkills(): SkillIndexEntry[] {
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    this.#ensureSkillIndex();
    return [...this.storage.skillIndex.list()];
  }

  async updateMetadata(options: {
    title?: string;
    description?: string;
    icon?: string;
    branch?: string;
  }): Promise<void> {
    let meta = this.getMetadata();
    let changed = false;

    if (options.title !== undefined && options.title !== meta.title) { meta.title = options.title; changed = true; }
    if (options.description !== undefined && options.description !== meta.description) { meta.description = options.description; changed = true; }
    if (options.icon !== undefined && options.icon !== meta.icon) { meta.icon = options.icon; changed = true; }
    if (options.branch !== undefined) {
      if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
      let branch = options.branch.trim();
      if (!GIT_BRANCH_RE.test(branch)) throw new Error("Git branch is invalid.");
      if (branch !== meta.content.branch) {
        meta.content.branch = branch;
        delete meta.content.commit;
        changed = true;
      }
    }

    if (changed) {
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      await this.#propagate();
    }
  }

  // Mark or unmark this collection as organization truth. Admin-gated at the API layer and kept
  // out of updateMetadata so collection owners can't set it. Must bump lastUpdated: the registry's
  // staleness guard skips the KV rewrite for an unchanged timestamp, and the flag only reaches
  // consumers through that snapshot.
  async setCanonical(canonical: boolean): Promise<void> {
    let meta = this.getMetadata();
    if (!!meta.canonical === canonical) return;
    if (canonical) meta.canonical = true;
    else delete meta.canonical;
    meta.lastUpdated = new Date();
    this.storage.metadata.put(meta);
    await this.#propagate();
    await this.#armLintAlarm();
  }

  // Arm the daily health pass for canonical web collections; idempotent (an armed alarm stays).
  // Demotion doesn't cancel: the next firing sees the flag gone and lets the alarm lapse.
  async #armLintAlarm(): Promise<void> {
    if (!this.getMetadata().canonical || this.#isGitBased()) return;
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + LINT_INTERVAL_MS);
    }
  }

  // The OKF health pass. Findings append to log.md as one Lint event; a clean run stays silent
  // (a daily "no findings" line would bury the history the log exists to keep).
  async alarm(): Promise<void> {
    let meta = this.getMetadata();
    if (!meta.id || !meta.canonical || this.#isGitBased()) return;

    let findings = lintCollection({
      records: [...this.storage.documents.list()].map(record => ({
        path: record.path,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        body: record.body,
        lastUpdated: record.lastUpdated,
      })),
      canonical: true,
      now: new Date(),
      bundledPackVersions: new Map(KNOWLEDGE_PACKS.map(pack => [pack.id, pack.version])),
    });

    if (findings.length > 0) {
      let now = new Date();
      this.storage.transaction(() => {
        let current = this.getMetadata();
        current.documentCount += this.#updateSystemFiles(current, {
          at: now,
          action: "Lint",
          detail: findings.join(" "),
          actor: "process:knowledge-lint",
        });
        current.lastUpdated = now;
        this.storage.metadata.put(current);
      });
      await this.#propagate();
    }
    await this.ctx.storage.setAlarm(Date.now() + LINT_INTERVAL_MS);
  }

  // --- Document CRUD ---

  #assertWebWritable(): void {
    if (this.#isGitBased()) {
      throw new Error("Git-based collections are read-only. All changes must be made through git.");
    }
  }

  #assertNotSystemFile(path: string): void {
    if (path === OKF_INDEX_PATH || path === OKF_LOG_PATH) {
      throw new Error(`${path} is system-maintained and cannot be edited directly.`);
    }
  }

  // Regenerate the root index.md and append a log event, inside the caller's transaction.
  // `meta` is the caller's in-flight metadata (its description feeds the index intro). Returns
  // how many system records were newly created so the caller can adjust documentCount. Git
  // collections carry their own bundle files and are skipped (the sync snapshot would clobber
  // system writes anyway).
  #updateSystemFiles(meta: ContextCollectionMetadata, event: LogEvent): number {
    if (this.#isGitBased()) return 0;

    let entries: IndexEntry[] = [];
    for (let record of this.storage.documents.list()) {
      if (record.path === OKF_INDEX_PATH || record.path === OKF_LOG_PATH) continue;
      if (isUnderReferences(record.path)) continue;
      let okf = this.#parseOkf(record);
      // In canonical folders the index reaches assistant context as authoritative, so entries
      // that don't meet the precedence bar (stable + human-reviewed) are marked pending.
      let pendingReview = !!meta.canonical && !!okf &&
          (okf.status !== "stable" || okf.tier !== "human-reviewed");
      entries.push({
        path: record.path,
        name: okf?.title ?? record.name,
        ...(okf?.type ? { type: okf.type } : {}),
        ...(okf?.description ?? record.description
            ? { description: okf?.description ?? record.description }
            : {}),
        ...(pendingReview ? { pendingReview: true } : {}),
      });
    }

    let created = 0;
    let existingIndex = this.storage.documents.get(OKF_INDEX_PATH);
    if (!existingIndex) created++;
    this.storage.documents.put({
      path: OKF_INDEX_PATH, name: OKF_INDEX_PATH,
      description: "Folder contents grouped by type. System-maintained.",
      contentType: "text/markdown",
      body: generateIndexMarkdown(meta, entries, existingIndex?.body),
      lastUpdated: event.at,
    });

    let existingLog = this.storage.documents.get(OKF_LOG_PATH);
    if (!existingLog) created++;
    this.storage.documents.put({
      path: OKF_LOG_PATH, name: OKF_LOG_PATH,
      description: "Chronological record of changes. System-maintained.",
      contentType: "text/markdown",
      body: appendLogEntry(existingLog?.body, meta.title, event),
      lastUpdated: event.at,
    });
    return created;
  }

  async listContextDocuments(prefix?: string): Promise<ContextDocumentSummary[]> {
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    let options = prefix ? { prefix } : undefined;
    let result: ContextDocumentSummary[] = [];
    for (let record of this.storage.documents.list(options)) {
      let manifest = this.#parseAgentSkill(record);
      let okf = this.#parseOkf(record);
      result.push({
        path: record.path,
        name: record.name,
        description: manifest?.description ?? record.description,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        ...(manifest ? {skillName: manifest.name} : {}),
        ...(okf ? {okf} : {}),
        lastUpdated: record.lastUpdated,
      });
    }
    return result;
  }

  // Lenient read: bad/missing paths return null, not RPC errors. Mutations validate paths.
  async getContextDocument(path: string): Promise<ContextDocument | null> {
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let record = this.storage.documents.get(path);
    if (!record) return null;
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    let manifest = this.#parseAgentSkill(record);
    let okf = this.#parseOkf(record);
    return {
      path: record.path,
      name: record.name,
      description: manifest?.description ?? record.description,
      contentType,
      body: record.body,
      ...(record.extractedText ? {extractedText: record.extractedText} : {}),
      ...(manifest ? {skillName: manifest.name} : {}),
      ...(okf ? {okf} : {}),
      lastUpdated: record.lastUpdated,
    };
  }

  async putContextDocument(
      path: string,
      doc: { description: string; body: string; contentType?: string },
      opts?: { actor?: string; system?: boolean }): Promise<ContextPutResult> {
    this.#assertWebWritable();
    validateDocumentPath(path);
    // Trusted server-side callers (pack installs) may write the reserved files; the client-facing
    // ContextApi never passes `system`, so users can't. Regeneration preserves an installed
    // index's unknown frontmatter keys (pack versions) while taking over its body.
    if (!opts?.system) this.#assertNotSystemFile(path);
    // Enforce real UTF-8 bytes, not UTF-16 code units.
    let byteLength = new TextEncoder().encode(doc.body).length;
    if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(`Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }

    let contentType = doc.contentType || contentTypeFromPath(path);
    let record: ContextRecord = {
      path, name: baseName(path), description: doc.description, contentType, body: doc.body, lastUpdated: new Date(),
    };

    // Convertible binary documents get a derived text extraction so search and agents can see
    // inside them while the stored body stays the byte-perfect original. Best-effort: extraction
    // failure (or a deployment without the WORKERS_AI binding) stores the original alone.
    if (isConvertibleDocumentContentType(contentType) && this.env.WORKERS_AI) {
      try {
        let extracted = await convertStoredDocumentToMarkdown(
            this.env.WORKERS_AI, record.name, doc.body, contentType);
        record.extractedText = extracted.slice(0, MAX_DOCUMENT_BODY_BYTES);
      } catch (error) {
        logger.warn("failed to extract document text", {
          event: "context.document.extract.failed", error,
        });
      }
    }

    this.storage.transaction(() => {
      let isNew = !this.storage.documents.get(path);
      // Use the file name from the path as the display name.
      this.#putDocument(record);

      let meta = this.getMetadata();
      if (isNew) meta.documentCount++;
      meta.documentCount += this.#updateSystemFiles(meta, {
        at: record.lastUpdated,
        action: isNew ? "Creation" : "Update",
        detail: `[${path}](/${path})`,
        actor: opts?.actor,
      });
      meta.lastUpdated = record.lastUpdated;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
    await this.#armLintAlarm();

    let okf = this.#parseOkf(record);
    return okf ? { okf } : {};
  }

  // Record that a person confirmed this concept file's content: append a `verified` stamp and
  // promote a draft to stable. Verification is the gate the profile's requirements guard, so a
  // file with outstanding OKF issues (strict issues too, when this collection is canonical) is
  // rejected rather than stamped. The rewritten record's lastUpdated equals the stamp's `at`, so
  // the new verification counts while any later edit outdates it again.
  async verifyContextDocument(path: string, opts?: { actor?: string }): Promise<ContextPutResult> {
    this.#assertWebWritable();
    validateDocumentPath(path);
    this.#assertNotSystemFile(path);
    let record = this.storage.documents.get(path);
    if (!record) throw new Error(`Document not found: ${path}`);
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    if (!isOkfConceptPath(path, contentType)) {
      throw new Error("Only markdown concept files can be verified.");
    }

    let evaluation = evaluateOkf(record.body);
    let blocking = [...evaluation.issues,
                    ...(this.getMetadata().canonical ? evaluation.strictIssues : [])];
    if (blocking.length > 0) {
      throw new Error(`Resolve OKF issues before verifying: ${blocking[0]}`);
    }

    let now = new Date();
    let actor = opts?.actor ?? "human:unknown";
    let updated: ContextRecord = {
      ...record,
      body: appendVerification(record.body, actor, now),
      lastUpdated: now,
    };
    this.storage.transaction(() => {
      this.#putDocument(updated);
      let meta = this.getMetadata();
      meta.documentCount += this.#updateSystemFiles(meta, {
        at: now,
        action: "Verification",
        detail: `[${path}](/${path})`,
        actor: opts?.actor,
      });
      meta.lastUpdated = now;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
    await this.#armLintAlarm();

    let okf = this.#parseOkf(updated);
    return okf ? { okf } : {};
  }

  // Retract verification: verified stamps are dropped and the file returns to draft, losing
  // precedence immediately. Same gates as verify; the retraction is logged with its actor.
  async unverifyContextDocument(
      path: string, opts?: { actor?: string }): Promise<ContextPutResult> {
    this.#assertWebWritable();
    validateDocumentPath(path);
    this.#assertNotSystemFile(path);
    let record = this.storage.documents.get(path);
    if (!record) throw new Error(`Document not found: ${path}`);
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    if (!isOkfConceptPath(path, contentType)) {
      throw new Error("Only markdown concept files can be unverified.");
    }

    let now = new Date();
    let updated: ContextRecord = {
      ...record,
      body: removeVerification(record.body),
      lastUpdated: now,
    };
    this.storage.transaction(() => {
      this.#putDocument(updated);
      let meta = this.getMetadata();
      meta.documentCount += this.#updateSystemFiles(meta, {
        at: now,
        action: "Unverification",
        detail: `[${path}](/${path})`,
        actor: opts?.actor,
      });
      meta.lastUpdated = now;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
    await this.#armLintAlarm();

    let okf = this.#parseOkf(updated);
    return okf ? { okf } : {};
  }

  async deleteContextDocument(path: string, opts?: { actor?: string }): Promise<void> {
    this.#assertWebWritable();
    // Mutations reject invalid paths; reads stay lenient.
    validateDocumentPath(path);
    this.#assertNotSystemFile(path);
    let existing = this.storage.documents.get(path);
    if (!existing) throw new Error(`Document not found: ${path}`);

    this.storage.transaction(() => {
      this.#deleteDocument(path);

      let meta = this.getMetadata();
      meta.documentCount = Math.max(0, meta.documentCount - 1);
      let now = new Date();
      meta.documentCount += this.#updateSystemFiles(meta, {
        at: now,
        action: "Deletion",
        detail: `[${path}](/${path})`,
        actor: opts?.actor,
      });
      meta.lastUpdated = now;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
    await this.#armLintAlarm();
  }

  async moveContextDocument(from: string, to: string, opts?: { actor?: string }): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(from);
    validateDocumentPath(to);
    this.#assertNotSystemFile(from);
    this.#assertNotSystemFile(to);
    if (from === to) return;

    // Reject moving a folder into one of its own descendants.
    if (to.startsWith(from + "/")) {
      throw new Error("Cannot move a folder into itself.");
    }

    let moves: { record: ContextRecord; newPath: string }[] = [];
    let exact = this.storage.documents.get(from);
    if (exact) {
      moves.push({ record: exact, newPath: to });
    } else {
      let fromPrefix = from.endsWith("/") ? from : from + "/";
      let toPrefix = to.endsWith("/") ? to : to + "/";
      for (let record of this.storage.documents.list({ prefix: fromPrefix })) {
        moves.push({ record, newPath: toPrefix + record.path.slice(fromPrefix.length) });
      }
    }

    if (moves.length === 0) throw new Error(`Nothing to move at: ${from}`);

    let movedFrom = new Set(moves.map(m => m.record.path));
    for (let m of moves) {
      if (!movedFrom.has(m.newPath) && this.storage.documents.get(m.newPath)) {
        throw new Error(`Destination already exists: ${m.newPath}`);
      }
    }

    this.storage.transaction(() => {
      for (let m of moves) {
        this.#deleteDocument(m.record.path);
      }
      for (let m of moves) {
        // Update the file name and content type for the new path.
        let contentType = extOf(m.record.path) !== extOf(m.newPath)
          ? contentTypeFromPath(m.newPath)
          : m.record.contentType;
        let record: ContextRecord = {
          ...m.record,
          path: m.newPath,
          name: baseName(m.newPath),
          contentType,
          lastUpdated: new Date(),
        };
        this.#putDocument(record);
      }

      let meta = this.getMetadata();
      let now = new Date();
      meta.documentCount += this.#updateSystemFiles(meta, {
        at: now,
        action: "Move",
        detail: `[${from}](/${from}) → [${to}](/${to})`,
        actor: opts?.actor,
      });
      meta.lastUpdated = now;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
    await this.#armLintAlarm();
  }

  // --- Artifact-backed projection ---

  async syncArtifactSource(): Promise<void> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    await this.#refreshArtifactSource();
  }

  async createGitToken(): Promise<ContextGitTokenCreateResult> {
    let meta = this.getMetadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    let repo = await this.#artifacts().get(meta.id);
    let token = await repo.createToken("write", GIT_TOKEN_TTL_SECONDS);
    return {
      id: token.id,
      plaintext: token.plaintext,
      remote: meta.content.remote,
    };
  }

  async listGitTokens(): Promise<ContextGitTokenList> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.getMetadata();
    let repo = await this.#artifacts().get(meta.id);
    let result = await repo.listTokens();
    return {
      tokens: result.tokens
        // User-created tokens for mirror setup are always write tokens. This DO
        // mints its own read tokens for cloning the repo into memory which we
        // don't want to expose the user.
        .filter(token => token.scope === "write" && token.state === "active")
        .map(token => ({
          id: token.id,
          expiresAt: token.expiresAt,
        })),
    };
  }

  async revokeGitToken(tokenId: string): Promise<boolean> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.getMetadata();
    let repo = await this.#artifacts().get(meta.id);
    return repo.revokeToken(tokenId);
  }

  #isGitBased(): boolean {
    return this.getMetadata().content.source === "git";
  }

  #startBackgroundArtifactRefresh(): void {
    if (!this.env.ARTIFACTS) return;
    let content = this.getMetadata().content;
    if (content.source !== "git") return;
    if (Date.now() - content.lastRefreshedAt.getTime() < GIT_REFRESH_MIN_INTERVAL_MS) return;

    void this.#refreshArtifactSource().catch((err) => {
      logger.warn("failed to refresh git-based context collection in the background", {
        event: "context.collection.git.refresh.failed",
        collectionId: this.getMetadata().id,
        error: err,
      });
    });
  }

  #refreshArtifactSource(): Promise<void> {
    if (this.#artifactRefresh) return this.#artifactRefresh;

    let promise = this.#loadArtifactSnapshot().finally(() => {
      if (this.#artifactRefresh === promise) this.#artifactRefresh = undefined;
    });
    this.#artifactRefresh = promise;
    return promise;
  }

  #replaceArtifactDocuments(commit: string, documents: ContextDocument[]): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();
      for (let doc of documents) {
        this.#putDocument(doc);
      }

      let meta = this.getMetadata();
      meta.documentCount = documents.length;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  #deleteArtifactDocuments(commit: string): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();

      let meta = this.getMetadata();
      meta.documentCount = 0;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  async #loadArtifactSnapshot(): Promise<void> {
    const meta = this.getMetadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    const result = await readArtifactRepoDocuments(
        this.#artifacts(), meta.id, meta.content.remote, meta.content.branch, meta.content.commit);
    if (!result.changed) {
      // Nothing changed, just bump the refresh timestamp.
      const latestMeta = this.getMetadata();
      if (latestMeta.content.source !== "git") throw new Error("Collection is not git-based.");
      latestMeta.content = { ...latestMeta.content, lastRefreshedAt: new Date() };
      this.storage.metadata.put(latestMeta);
      return;
    }

    if (result.commit) {
      // The repo was updated to a new commit, stored documents need to be updated.
      this.#replaceArtifactDocuments(result.commit, result.documents);
    } else {
      // The repo was updated to an empty state.
      this.#deleteArtifactDocuments(result.commit);
    }
    await this.#propagate();
  }

  // --- Search ---

  // Linear scan over one collection. Replace with an index if collection size makes it matter.
  async search(query: string, limit: number = 20): Promise<{ path: string; name: string; description: string; snippet?: string; score: number }[]> {
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];

    let results: { path: string; name: string; description: string; snippet?: string; score: number }[] = [];

    for (let record of this.storage.documents.list()) {
      let score = 0;
      let snippet: string | undefined;

      let isText = isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE);
      // Binary documents search through their derived extraction (when one exists), so a .docx
      // is findable by its contents, not just its name.
      let searchableBody = isText ? record.body : record.extractedText ?? "";
      let nameLower = record.name.toLowerCase();
      let descLower = record.description.toLowerCase();
      let bodyLower = searchableBody.toLowerCase();

      for (let token of tokens) {
        if (nameLower.includes(token)) score += 10;
        if (descLower.includes(token)) score += 5;
        let bodyIdx = bodyLower.indexOf(token);
        if (bodyIdx >= 0) {
          score += 1;
          if (!snippet) {
            let start = Math.max(0, bodyIdx - 40);
            let end = Math.min(searchableBody.length, bodyIdx + token.length + 80);
            snippet = (start > 0 ? "..." : "") + searchableBody.slice(start, end) + (end < searchableBody.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({ path: record.path, name: record.name, description: record.description, snippet, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // --- Deletion ---

  async deleteSelf(): Promise<void> {
    let meta = this.getMetadata();
    let id = meta.id;

    if (id) {
      if (meta.visibility === "public") {
        await this.#registry().removePublic(this.#domain(), id);
      } else {
        await this.#ownerLibrary().removeOwnedCollection(id);
      }
    }

    if (meta.content.source === "git" && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(id).catch((err) => {
        logger.warn("failed to delete Artifacts repo for context collection", {
          event: "artifacts.repo.delete.failed",
          collectionId: id,
          error: err,
        });
      });
    }

    await this.ctx.storage.deleteAll();
  }

  // Account revocation clears the whole user-library index separately; don't update it per item.
  async deleteForRevokedOwner(): Promise<void> {
    let meta = this.getMetadata();
    if (meta.content.source === "git" && meta.id && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(meta.id).catch((err) => {
        logger.warn("failed to delete Artifacts repo while revoking context collection owner", {
          event: "artifacts.repo.delete.for.revoked.owner.failed",
          collectionId: meta.id,
          error: err,
        });
      });
    }
    await this.ctx.storage.deleteAll();
  }

  // --- Propagation ---

  // Refresh this collection's denormalized summary in its index.
  async #propagate(): Promise<void> {
    let meta = this.getMetadata();
    let summary = metadataToSummary(meta);

    if (meta.visibility === "public") {
      await this.#registry().syncPublic(this.#domain(), summary);
    } else {
      await this.#ownerLibrary().updateOwnedCollection(meta.id, summary);
    }
  }
}
