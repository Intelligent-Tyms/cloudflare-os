import { AdminFormat, AdminFormatPatch, AdminFormatsView, AdminCatalogModel, AdminModel, AdminResourceVendor, AdminSkill, AmbientGatekeeperMode, BlueprintPublicInfo, INTELLIGENCE_PRODUCT_KINDS, INTELLIGENCE_PRODUCT_NAMES, IntelligenceInstanceView, IntelligenceOverview, IntelligenceProductKind, IntelligenceProductOverview, ChannelsDescription, EmailInbox, SUGGESTED_MODELS, SkillMarketplaceEntry, TelegramBinding, TelegramLinkCode, isAmbientGatekeeperMode, AiModelConfig, AiModelProvider, GatewayModel, GatewayModelLevelTest, GatewayModelMode, GatewayModelSettings, GatewayModelTest, ReasoningLevel } from '@gadgets/workshop-shared/api';
import { GatekeeperVendor, SKILL_PACKAGE_MAX_FILES, SKILL_PACKAGE_MAX_FILE_BYTES, SKILL_PACKAGE_MAX_TOTAL_BYTES, SkillPackage, SkillPackageFile, VendorSetup } from '@gadgets/workshop-shared/gatekeeper';
import { DurableObject } from 'cloudflare:workers';
import { RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { createWorkshopLogger } from "./observability";
import { ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, listFeaturedBlueprintsFromKv, parseBlueprintKvRecord, readBlueprintKvRecord, serializeFeaturedBlueprints } from './storage-schema/blueprints-kv.js';
import { sanitizeBlueprintOutput } from './blueprint-archive.js';
import { AdminConfig, FormatCuration, makeAdminSettingsStorage, type AdminSettingsStorage } from './storage-schema/admin-settings-storage.js';
import { MAX_AGENT_HINT, defaultOutputFormatId, listPromotedFormats, normalizeAdminConfig, reorderFormats, sanitizeOutputOverrides, serializeAdminConfig, sanitizeAddedModel, sanitizeModelSettings } from './admin-config.js';
import { SITE_LOGO_R2_KEY, validateSiteLogo } from './site-logo.js';
import { getModelTokenLimits } from './agent-compaction.js';
import { AiGatewayConfig, GatewayModels, assertGatewayProvider, gatewayModelConfig, gatewayRunConfig, getAiGatewayConfig, isCatalogModel } from './ai-gateway.js';
import { AgentTurnError, completeText } from './ai-invoke.js';
import { gatewayReasoningLevels, getModel, isRuntimeModel } from './ai-models.js';
import { ambientGatekeeperMode, DEFAULT_AMBIENT_GATEKEEPER_MODE } from './provisioning-policy.js';
import { buildGatekeeperVendorMap } from './auth/auth-vendors.js';
import { UserDurableObject } from './user.js';
import { bundledBlueprintsManifestVersion, deleteInstalledBlueprint, installBundledBlueprints, RETIRED_BLUEPRINT_IDS } from './bundled-blueprints.js';
import { BUNDLED_BLUEPRINTS } from './generated/bundled-blueprints.js';
import * as intelligenceDirectory from './intelligence-directory.js';
import { CENTRAL_CATALOG_CHECK_MS, CENTRAL_CATALOG_REFRESH_MS, CENTRAL_SETTINGS_POLL_MS, CentralCatalog, CentralSettings, CentralSettingsPull, adoptCentralSettings, catalogFingerprint, centralSettingsOf, fetchCentralLogo, hasCentralSettings, pullCentralSettings, reportCatalog, seedCentralSettings } from './central-settings.js';
import { INTELLIGENCE_CONNECTORS, type IntelligenceConnectorSetup } from './intelligence-setup.js';

const logger = createWorkshopLogger("workshop.admin.settings");

// The AdminConfig fields the admin portal owns once central settings are applied.
const CENTRAL_SETTING_KEYS = new Set<keyof CentralSettings>(
    ["organizationProfile", "instanceInstructions", "siteName", "accentColor", "announcement", "banner",
      "disabledSkills", "disabledModels"]);
const MANAGED_ON_PORTAL = "This setting is managed on the admin portal.";

// listDeploymentSkills/installSkillPackage are optional on GatekeeperVendor (like createAccount):
// callers gate on the VendorDescription flags and view the stub through the Required shape, since
// RPC stub types don't narrow optional methods.
type SkillListerStub = Required<Pick<GatekeeperVendor, "listDeploymentSkills">>;
type SkillInstallerStub = Required<Pick<GatekeeperVendor, "installSkillPackage">>;
type VendorSetupStub = Required<Pick<GatekeeperVendor, "describeSetup" | "applySetup" | "clearSetup">>;


// Bounds on admin-entered vendor setup values forwarded to the vendor (which re-validates
// against its own input schema).
const SETUP_MAX_VALUES = 16;
const SETUP_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SETUP_VALUE_MAX_LENGTH = 2048;

// Identifier shape for marketplace catalog ids (path-segment safe: interpolated into the
// package-fetch URL).
const MARKETPLACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Which messaging channels the deployment's channels worker has configured, or null when no
// channels worker is bound. A bound-but-unreachable worker also reports null (logged, not
// thrown) so one bad deploy can't take down the whole settings view.
async function describeChannels(env: Cloudflare.Env): Promise<ChannelsDescription | null> {
  if (!env.CHANNELS) return null;
  try {
    return await env.CHANNELS.describeChannels();
  } catch (error) {
    logger.warn("failed to describe messaging channels", {
      event: "channels.describe.failed", error,
    });
    return null;
  }
}

// The entries of a record keyed by model ID (a model's mode, or its settings) other than
// `modelId`'s. Callers rebuild the record with Object.fromEntries, which defines own properties:
// assigning into a copy would lose the entry of a model whose ID is "__proto__".
function entriesWithout<T>(record: Record<string, T>, modelId: string): [string, T][] {
  return Object.entries(record).filter(([id]) => id !== modelId);
}

// The compaction budget a gateway model has while its settings give none, and the largest one
// they may give it: the room its window leaves for a prompt.
function compactionBudgetRange(model: AdminModel): { builtIn: number, max: number } {
  let config = gatewayModelConfig(model);
  return {
    builtIn: getModelTokenLimits(config).inputBudget,
    // A budget is capped at that room, so an unbounded one reads it back.
    max: getModelTokenLimits({ ...config, compactionInputBudget: Infinity }).inputBudget,
  };
}

// The model that `model`, a description of one, becomes once added: enabled, with nothing set
// for it.
function addedModel(model: GatewayModel): AdminModel {
  return { ...model, mode: "enabled", defaultMode: "enabled", added: true };
}

// One of the tests an admin runs through the gateway: the event and the message of its log line,
// the response cap of its request (the model's own, where that is lower), whether the request
// asks for what an agent's turn would (see completeText), and how long the model has to answer.
type GatewayTest = {
  event: string, logged: string, maxTokens: number, thinking: boolean, timeoutMs: number,
};
const PROVIDER_TEST: GatewayTest = {
  event: "gateway.provider.test", logged: "tested an AI Gateway provider",
  maxTokens: 16, thinking: false, timeoutMs: 15_000,
};
const MODEL_TEST: GatewayTest = {
  event: "gateway.model.test", logged: "tested an AI Gateway model",
  maxTokens: 2048, thinking: true, timeoutMs: 30_000,
};

// What a failed test tells the admin: the provider's or the gateway's own words with the
// deployment's gateway token cut out, should they repeat it, on one line and cut short.
function testFailureMessage(text: string, apiToken: string | undefined): string {
  if (apiToken) text = text.replaceAll(apiToken, "[redacted]");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Deployment-wide admin settings singleton.
 *
 * This durable object is always addressed as `getByName("")`. It contains settings that only
 * admins may modify. Settings modified through this DO are published to KV so that user requests
 * do not have to access the AdminSettings DO directly (which they could otherwise overload), but
 * having a singleton DO writing to KV avoids race conditions when updating KV.
 */
export class AdminSettings extends DurableObject<Cloudflare.Env> {
  private storage: AdminSettingsStorage;
  private users: DurableObjectNamespace<UserDurableObject>;
  // Every bound gatekeeper, keyed by vendor id. Deployment-global (from env bindings), so admin
  // resource listing needs no user context.
  private vendors: Map<string, Service<GatekeeperVendor>>;
  // Every config setter writes the same authoritative singleton and KV mirror. Serialize the full
  // read/modify/write operation so external KV I/O cannot let concurrent setters lose updates.
  private adminConfigMutationTail = Promise.resolve();
  // R2 and config are separate stores. Serialize logo changes so reset/upload operations cannot
  // interleave while switching whether the fixed public object is enabled.
  private siteLogoMutationTail = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeAdminSettingsStorage(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
    this.vendors = buildGatekeeperVendorMap(env);
  }

  /**
   * Install the bundled blueprints bundled with this deployment, if that hasn't already happened
   * for this exact manifest. Idempotent and cheap: an up-to-date deployment does one string
   * comparison and returns.
   *
   * Written straight into the featured mirror rather than through setBlueprintFeatured(), whose
   * authoritative bit lives in the publishing user's DO -- these have no owning user.
   *
   * Callers are coalesced onto one run, or two isolates racing on a fresh deployment both promote
   * the same blueprints, and a duplicated id makes setFormatOrder() reject every reordering.
   */
  ensureBundledBlueprintsInstalled(): Promise<boolean> {
    return this.#installInFlight ??= this.#installBundledBlueprints()
        .finally(() => { this.#installInFlight = undefined; });
  }

  #installInFlight?: Promise<boolean>;

  // Resolves true once every bundled blueprint is live. A partial install resolves false rather
  // than throwing: the caller has nothing to handle, but it does need to know to ask again.
  async #installBundledBlueprints(): Promise<boolean> {
    let complete = true;
    let manifestVersion = bundledBlueprintsManifestVersion();
    if (this.storage.installedFormatBlueprints.get() !== manifestVersion) {
      let installed = await installBundledBlueprints(this.env);

      if (installed.length > 0) {
        for (let publicInfo of installed) {
          this.storage.featuredBlueprints.put(publicInfo);
        }
        await this.#writeFeaturedSnapshot();
      }

      // Stamped only once the whole manifest is live, so a crash or a single bad archive retries
      // next time. Recording a partial install as complete would strand the entries that failed
      // until the manifest happened to change again.
      complete = installed.length === BUNDLED_BLUEPRINTS.length;
      if (complete) {
        this.storage.installedFormatBlueprints.put(manifestVersion);
      }
      logger.info("installed bundled blueprints", {
        event: "formats.install.complete",
        size: installed.length,
        failureCount: BUNDLED_BLUEPRINTS.length - installed.length,
      });
    }

    await this.#withdrawRetiredBlueprints();

    // Promotion is checked on every run, not just after an install, so a deployment that installed
    // before curation existed still ends up offering its bundled formats.
    await this.#promoteBundledFormats();
    return complete;
  }

  // Withdraw each retired blueprint once: out of the featured mirror and the standard formats
  // first, so nothing offers it while its records go, then its KV record and R2 content. A failure
  // leaves the rest pending for the next run rather than failing the install.
  async #withdrawRetiredBlueprints(): Promise<void> {
    let withdrawn = new Set(this.storage.withdrawnRetiredBlueprints.get());
    let pending = RETIRED_BLUEPRINT_IDS.filter(id => !withdrawn.has(id));
    if (pending.length === 0) return;

    try {
      let featuredChanged = false;
      for (let id of pending) {
        if (this.storage.featuredBlueprints.get(id)) {
          this.storage.featuredBlueprints.delete(id);
          featuredChanged = true;
        }
      }
      if (featuredChanged) await this.#writeFeaturedSnapshot();

      await this.#mutateFormats(formats => {
        let next = formats.filter(f => !pending.includes(f.blueprintId));
        return next.length === formats.length ? null : next;
      });

      for (let id of pending) {
        let deleted = await deleteInstalledBlueprint(this.env, id);
        withdrawn.add(id);
        this.storage.withdrawnRetiredBlueprints.put([...withdrawn]);
        logger.info("withdrew retired blueprint", {
          event: "formats.retired.withdrawn", blueprintId: id,
          outcome: deleted ? "ok" : "error", reason: deleted ? undefined : "user-owned",
        });
      }
    } catch (err) {
      logger.error("failed to withdraw retired blueprints", {
        event: "formats.retired.failed", error: err,
      });
    }
  }

  // Offer each bundled blueprint as a standard format, once ever. A separate one-shot decision per
  // blueprint: re-deriving the list from the manifest would undo an admin's removal on every
  // startup, and reinstalling an updated archive must refresh the blueprint without resetting how
  // the deployment has chosen to offer it.
  //
  // The converse isn't handled: a blueprint dropped from the bundle, or given a new blueprintId,
  // leaves its record and its promotion behind for an admin to remove by hand. Withdrawing them
  // would mean tracking which promotions this installer made, which is worth doing before the
  // bundled set ever changes.
  async #promoteBundledFormats(): Promise<void> {
    let promoted = new Set(this.storage.promotedFormatBlueprints.get());
    let pending = BUNDLED_BLUEPRINTS.filter(entry => !promoted.has(entry.blueprintId));
    if (pending.length === 0) return;

    let config = this.#config();
    let known = new Set(config.formats.map(f => f.blueprintId));
    let added = pending
        .filter(entry => !known.has(entry.blueprintId))
        .map(entry => ({blueprintId: entry.blueprintId, enabled: true}));
    // Always write, even when every pending format is already in DO storage. That is the retry
    // state after a prior KV mirror failure; stamping promotion without writing would strand the
    // hot-path mirror on its old config forever.
    await this.updateAdminConfig({formats: [...config.formats, ...added]});

    for (let entry of pending) promoted.add(entry.blueprintId);
    this.storage.promotedFormatBlueprints.put([...promoted]);
  }

  async #writeFeaturedSnapshot(): Promise<void> {
    let featured = [...this.storage.featuredBlueprints.list()];
    await this.env.BLUEPRINTS.put(FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints(featured));
  }

  // Reconcile the mirrored featured list to match the authoritative bit stored in the owner
  // User DO, while also refreshing stale metadata snapshots for featured entries.
  async #syncFeaturedMirror(publicInfo: BlueprintPublicInfo, featured: boolean): Promise<void> {
    let existing = this.storage.featuredBlueprints.get(publicInfo.id);
    let changed = false;

    if (!featured) {
      if (existing) {
        this.storage.featuredBlueprints.delete(publicInfo.id);
        changed = true;
      }
    } else if (
      !existing ||
      existing.metadata.version !== publicInfo.metadata.version ||
      existing.metadata.lastUpdated.valueOf() !== publicInfo.metadata.lastUpdated.valueOf()
    ) {
      this.storage.featuredBlueprints.put(publicInfo);
      changed = true;
    }

    if (changed) {
      await this.#writeFeaturedSnapshot();
    }
  }

  async #getOwnerBlueprint(blueprintId: string): Promise<{
    // Absent for a blueprint with no owning user, in which case `featureable` is false.
    owner: DurableObjectStub<UserDurableObject> | undefined;
    publicInfo: BlueprintPublicInfo;
    featureable: boolean;
  }> {
    if (isReservedBlueprintKey(blueprintId)) {
      throw new Error('Template not found.');
    }

    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) {
      throw new Error('Template not found.');
    }

    let kvRecord = parseBlueprintKvRecord(raw);

    return {
      owner: kvRecord.ownerId
          ? this.users.get(this.users.idFromString(kvRecord.ownerId))
          : undefined,
      publicInfo: {
        id: blueprintId,
        metadata: kvRecord.metadata,
      },
      // A deployment-installed blueprint (see bundled-blueprints.ts) has no owning User DO to hold
      // the authoritative featured bit, so the owner-anchored toggle doesn't apply -- the same
      // answer as an uploaded blueprint. It reaches users through the deployment's curation.
      featureable: !!kvRecord.gadgetId && !!kvRecord.ownerId,
    };
  }

  async isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      return null;
    }

    let featured = await owner.isBlueprintFeatured(blueprintId);
    if (featured === null) {
      return null;
    }

    // Heal partial failures before answering so admin reads never observe disagreement.
    await this.#syncFeaturedMirror(publicInfo, featured);
    return featured;
  }

  async setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      throw new Error('Template not featureable.');
    }

    await owner.setBlueprintFeatured(blueprintId, featured);
    await this.#syncFeaturedMirror(publicInfo, featured);
  }

  async syncFeaturedBlueprint(publicInfo: BlueprintPublicInfo): Promise<void> {
    // Overseer propagation calls this after blueprint updates so the mirror keeps up with the
    // latest published metadata, but only while the owner-side featured bit stays enabled.
    await this.#syncFeaturedMirror(publicInfo, true);
  }

  async deleteFeaturedBlueprint(blueprintId: string): Promise<void> {
    if (this.storage.featuredBlueprints.get(blueprintId)) {
      this.storage.featuredBlueprints.delete(blueprintId);
      await this.#writeFeaturedSnapshot();
    }
  }

  // --- Deployment admin config ---

  // Every read of the stored config goes through the same normalization as the KV mirror. A
  // config persisted before a field existed is missing that field entirely; in particular,
  // userSearchEnabled has a dependent default and cannot be restored by a simple defaults spread.
  #config(): AdminConfig {
    return normalizeAdminConfig(this.storage.adminConfig.get());
  }

  getAdminConfig(): AdminConfig {
    return this.#config();
  }

  async #mutateAdminConfig(mutate: (config: AdminConfig) => AdminConfig): Promise<void> {
    let previousMutation = this.adminConfigMutationTail;
    let release!: () => void;
    this.adminConfigMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previousMutation;
    try {
      let current = this.#config();
      let next = mutate(current);
      this.storage.adminConfig.put(next);
      try {
        await this.env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(next));
      } catch (error) {
        this.storage.adminConfig.put(current);
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Merge a partial update into the admin config and mirror it to KV. Callers validate
   * scalar values; this just persists atomically.
   */
  updateAdminConfig(patch: Partial<AdminConfig>): Promise<void> {
    return this.#mutateAdminConfig(config => {
      if (config.centralSettingsVersion > 0
          && Object.keys(patch).some(key => CENTRAL_SETTING_KEYS.has(key as keyof CentralSettings))) {
        throw new Error(MANAGED_ON_PORTAL);
      }
      return { ...config, ...patch };
    });
  }

  // --- Central settings (central-settings.ts) ---

  /**
   * Start pulling the central settings if that isn't running yet. Like the format install, the
   * DO doesn't wake merely because someone deployed, so API traffic calls this once per isolate
   * (server.ts); from then on the alarm keeps the pull going.
   */
  async ensureCentralSettingsSync(): Promise<void> {
    if (!hasCentralSettings(this.env)) return;
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    if (!hasCentralSettings(this.env)) return;
    try {
      await this.syncCentralSettings();
    } catch (error) {
      // The last version applied stays in force; the next pull tries again.
      logger.warn("failed to sync central settings", { event: "central_settings.sync.failed", error });
    }
    await this.ctx.storage.setAlarm(Date.now() + CENTRAL_SETTINGS_POLL_MS);
  }

  /**
   * Pull the central settings and apply a version not applied yet. The first pull finds none
   * and seeds them with this deployment's own values, which then come back as version 1.
   */
  async syncCentralSettings(): Promise<void> {
    let config = this.#config();
    let applied = config.centralSettingsVersion;
    let pull: CentralSettingsPull = await pullCentralSettings(this.env, applied);
    if (pull.kind === "absent") {
      pull = await seedCentralSettings(this.env, centralSettingsOf(config), await this.#localLogo());
    } else if (pull.kind === "settings" && pull.missing.length > 0) {
      // The control plane's copy predates some fields: hand over ours for exactly those.
      pull = await adoptCentralSettings(this.env, centralSettingsOf(config),
          pull.missing.includes("logo") ? await this.#localLogo() : null);
    }
    if (pull.kind === "settings" && pull.version !== applied) await this.#applyCentralSettings(pull);
    await this.#maybeReportCatalog();
  }

  // This deployment's own logo, for the first hand-over; null when it has none.
  async #localLogo(): Promise<Uint8Array | null> {
    if (!this.#config().siteLogoConfigured) return null;
    let object = await this.env.BLUEPRINT_CONTENT.get(SITE_LOGO_R2_KEY);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async #applyCentralSettings(pull: Extract<CentralSettingsPull, { kind: "settings" }>): Promise<void> {
    let { version, settings: { logo, ...settings } } = pull;
    if (logo !== this.#config().centralLogoSha) {
      if (logo === "") {
        await this.setSiteLogo(null);
      } else {
        let fetched = await fetchCentralLogo(this.env);
        // A newer upload landed between the pull and the fetch: the next pull names it.
        if (fetched.sha256 !== logo) throw new Error("The central logo changed while fetching it.");
        validateSiteLogo(fetched.png);
        await this.setSiteLogo(fetched.png);
      }
    }
    await this.#mutateAdminConfig(config => ({
      ...config, ...settings, centralSettingsVersion: version, centralLogoSha: logo,
    }));
    logger.info("applied central settings", { event: "central_settings.applied", sequence: version });
  }

  // Report what can be switched off when it changed (checked every few minutes, not on every
  // pull: listing skills asks each skills vendor), and now and then regardless.
  async #maybeReportCatalog(): Promise<void> {
    let report = this.storage.centralCatalogReport.get();
    let now = Date.now();
    if (now - report.checkedAt < CENTRAL_CATALOG_CHECK_MS) return;
    let config = this.#config();
    let catalog: CentralCatalog = {
      skills: (await this.#listSkillConfig(config)).filter(s => !s.missing)
          .map(({ name, description, sources }) => ({ name, description, sources })),
      models: this.#listModelConfig(config)?.filter(m => !m.missing)
          .map(({ id, name, provider, freePlan }) => ({ id, name, provider, freePlan })) ?? null,
    };
    let fingerprint = await catalogFingerprint(catalog);
    // Checked now whatever the report does, so a failing one waits for the next check.
    this.storage.centralCatalogReport.put({ ...report, checkedAt: now });
    if (fingerprint === report.fingerprint && now - report.sentAt < CENTRAL_CATALOG_REFRESH_MS) return;
    await reportCatalog(this.env, catalog);
    this.storage.centralCatalogReport.put({ fingerprint, sentAt: now, checkedAt: now });
  }

  /** The connector catalog: every bound connector and its resource types, with what is on. */
  async getConnectors(adminUserId: string): Promise<AdminResourceVendor[]> {
    return this.#listResourceConfig(this.#config(), adminUserId);
  }

  /**
   * The standard formats and the blueprints that could become one, for the admin portal. Only
   * deployment-wide (featured) blueprints are offered: an admin's own published ones
   * belong to their Jamaa account, and featuring one there makes it available here.
   */
  async getFormats(): Promise<AdminFormatsView> {
    let [formats, featured] = await Promise.all([
      this.#listFormatConfig(this.#config()),
      listFeaturedBlueprintsFromKv(this.env),
    ]);
    let promoted = new Set(formats.map(f => f.blueprintId));
    return {
      formats,
      candidates: featured.filter(b => !promoted.has(b.id)).map(b => ({
        blueprintId: b.id,
        title: b.metadata.title,
        description: b.metadata.description ?? "",
        declared: b.metadata.output,
      })),
    };
  }

  // --- Deployment AI models ---

  // Admin view of the platform AI Gateway model catalog joined with the deployment's curation,
  // or null without a gateway (there is nothing to curate then). Every catalog
  // entry appears, disabled ones included; a disabled id that has since left the catalog is kept
  // and flagged `missing` so the admin can clear it. Catalog order is preserved (it is also the
  // picker order, and the first enabled entry is the default model).
  #listModelConfig(config: AdminConfig): AdminCatalogModel[] | null {
    let gwConfig = getAiGatewayConfig(this.env);
    if (!gwConfig) return null;

    let disabled = new Set(config.disabledModels);
    let result: AdminCatalogModel[] = [];
    let seen = new Set<string>();
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (!gwConfig.providers.has(provider)) continue;
      for (let [id, model] of Object.entries(models)) {
        seen.add(id);
        result.push({
          id,
          name: model.name,
          provider: provider as AdminCatalogModel["provider"],
          freePlan: model.freePlan === true,
          enabled: !disabled.has(id),
          missing: false,
        });
      }
    }
    for (let id of disabled) {
      if (!seen.has(id)) {
        result.push({ id, name: "", provider: "", freePlan: false, enabled: false, missing: true });
      }
    }
    return result;
  }


  // --- Standard output formats ---

  // Admin view of the promoted formats: the deployment's curation joined with each blueprint, so
  // the panel can show what is being curated and flag entries whose blueprint has been deleted.
  async #listFormatConfig(config: AdminConfig): Promise<AdminFormat[]> {
    let bundled = new Set(BUNDLED_BLUEPRINTS.map(entry => entry.blueprintId));

    // Every entry, not just the offered ones: the panel exists to show what is disabled and what
    // points at a deleted blueprint.
    return (await listPromotedFormats(this.env, config.formats)).map(
        ({entry, metadata, declared, output}) => ({
          blueprintId: entry.blueprintId,
          blueprintTitle: metadata?.title ?? "",
          blueprintDescription: metadata?.description ?? "",
          output,
          declared,
          overrides: entry.overrides,
          enabled: entry.enabled,
          agentHint: entry.agentHint ?? "",
          missing: !metadata,
          bundled: bundled.has(entry.blueprintId),
        }));
  }

  // Read-modify-write one format entry within the DO, so concurrent admin edits can't clobber each
  // other. `mutate` returns the replacement list, or null to leave the config untouched.
  async #mutateFormats(mutate: (formats: FormatCuration[]) => FormatCuration[] | null)
      : Promise<void> {
    await this.#mutateAdminConfig(config => {
      let next = mutate(config.formats);
      // A no-op may be a retry after the prior KV write failed but DO storage succeeded. Mirror the
      // current config again so idempotent retries repair that partial failure.
      return next ? {...config, formats: next} : config;
    });
  }

  async promoteFormat(blueprintId: string): Promise<void> {
    let record = await readBlueprintKvRecord(this.env, blueprintId);
    if (!record) {
      throw new Error("Template not found.");
    }
    await this.#mutateFormats(formats => {
      // Idempotent so retrying after a KV mirror failure reaches #mutateFormats()'s repair write.
      if (formats.some(f => f.blueprintId === blueprintId)) return null;
      // A blueprint that declares no output still needs a stable grouping key before the admin can
      // name it. Generate that hidden implementation detail here; the panel only asks the admin for
      // the human-facing noun, plural and icon.
      let declared = sanitizeBlueprintOutput(record.metadata.output);
      return [...formats, {
        blueprintId,
        enabled: true,
        ...(declared ? {} : {overrides: {id: defaultOutputFormatId(blueprintId)}}),
      }];
    });
  }

  async removeFormat(blueprintId: string): Promise<void> {
    // Enforced here, not just in the panel: this is an RPC an admin session can call directly.
    // Withdrawing a bundled entry is `enabled: false`, which keeps its overrides, hint and
    // position.
    if (BUNDLED_BLUEPRINTS.some(entry => entry.blueprintId === blueprintId)) {
      throw new Error(
          "This format ships with the deployment, so it can't be removed. Turn it off instead.");
    }
    await this.#mutateFormats(formats => {
      let next = formats.filter(f => f.blueprintId !== blueprintId);
      return next.length === formats.length ? null : next;
    });
  }

  async updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    await this.#mutateFormats(formats => formats.map(entry => {
      if (entry.blueprintId !== blueprintId) return entry;

      let next: FormatCuration = {...entry};
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.agentHint !== undefined) {
        // Truncated because every hint is repeated in the system prompt on every turn, so an
        // over-long one costs tokens on requests nobody connects back to this panel.
        let hint = patch.agentHint.trim().slice(0, MAX_AGENT_HINT);
        if (hint) next.agentHint = hint; else delete next.agentHint;
      }
      if (patch.overrides) {
        // null reverts a field to the blueprint's own declaration; absent leaves it alone.
        let merged: Record<string, unknown> = {...entry.overrides};
        for (let [key, value] of Object.entries(patch.overrides)) {
          if (value === null) delete merged[key]; else merged[key] = value;
        }
        let clean = sanitizeOutputOverrides(merged);
        if (clean) next.overrides = clean; else delete next.overrides;
      }
      return next;
    }));
  }

  async setFormatOrder(blueprintIds: string[]): Promise<void> {
    await this.#mutateFormats(formats => reorderFormats(formats, blueprintIds));
  }

  // --- Agent skills ---

  // Admin view of the deployment's agent skills: every skill hosted by a skills-providing vendor
  // (e.g. public Knowledge folders), joined with the deployment's curation. Skills are keyed by name;
  // the same name in several folders is one row (curation applies to all of them). A disabled name
  // whose skill has since disappeared is kept and flagged `missing` so the admin can clear it.
  async #listSkillConfig(config: AdminConfig): Promise<AdminSkill[]> {
    let disabled = new Set(config.disabledSkills);

    let listings = await Promise.all([...this.vendors].map(async ([id, vendor]) => {
      try {
        if ((await vendor.describe()).providesAgentSkills !== true) return [];
        return await (vendor as unknown as SkillListerStub).listDeploymentSkills();
      } catch (err) {
        logger.warn("failed to list deployment skills for gatekeeper", {
          event: "gatekeeper.skills.list.failed", gatekeeperId: id, error: err,
        });
        return [];
      }
    }));

    let byName = new Map<string, AdminSkill>();
    for (let skill of listings.flat()) {
      let existing = byName.get(skill.name);
      if (existing) {
        if (!existing.sources.includes(skill.source)) existing.sources.push(skill.source);
      } else {
        byName.set(skill.name, {
          name: skill.name,
          description: skill.description,
          sources: [skill.source],
          enabled: !disabled.has(skill.name),
          missing: false,
        });
      }
    }
    for (let name of disabled) {
      if (!byName.has(name)) {
        byName.set(name, {name, description: "", sources: [], enabled: false, missing: true});
      }
    }
    return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  // --- Skill marketplace ---
  //
  // The marketplace is a catalog the fleet operator curates, served from the URL this deployment
  // is configured with (SKILL_MARKETPLACE_URL). The catalog and package payloads are external
  // input: everything is shape-checked and clamped before use, and install content additionally
  // passes through the vendor's own validation.

  async #fetchMarketplace(path: string): Promise<unknown> {
    let base = this.env.SKILL_MARKETPLACE_URL?.trim();
    if (!base) throw new Error("This deployment has no skill marketplace configured.");
    let response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`The skill marketplace responded with status ${response.status}.`);
    }
    return await response.json();
  }

  // The catalog, or null when this deployment has no marketplace configured. Malformed entries
  // are dropped rather than failing the panel.
  async listSkillMarketplace(): Promise<SkillMarketplaceEntry[] | null> {
    if (!this.env.SKILL_MARKETPLACE_URL?.trim()) return null;
    let raw = await this.#fetchMarketplace("");
    let list = (raw as { packages?: unknown })?.packages;
    if (!Array.isArray(list)) throw new Error("The skill marketplace returned an invalid catalog.");
    let entries: SkillMarketplaceEntry[] = [];
    for (let item of list) {
      let { id, name, description, skills, repoUrl } = (item ?? {}) as Partial<SkillMarketplaceEntry>;
      if (typeof id !== "string" || !MARKETPLACE_ID_PATTERN.test(id)) continue;
      if (typeof name !== "string" || !name.trim()) continue;
      entries.push({
        id,
        name: name.trim().slice(0, 120),
        description: (typeof description === "string" ? description : "").slice(0, 1024),
        skills: Array.isArray(skills)
            ? skills.filter((s): s is string => typeof s === "string").slice(0, 32)
            : [],
        repoUrl: typeof repoUrl === "string" && /^https:\/\//.test(repoUrl) ? repoUrl : "",
      });
    }
    return entries;
  }

  // Fetch one package from the marketplace, validate it against the shared bounds, and hand it to
  // the vendor that persists skill packages. The vendor's duplicate-title refusal is what makes a
  // retried install safe.
  async installSkillPackage(id: string): Promise<void> {
    if (!MARKETPLACE_ID_PATTERN.test(id)) throw new Error("Invalid marketplace package id.");
    let raw = await this.#fetchMarketplace(`/${id}/package`) as {
      name?: unknown; description?: unknown; files?: unknown;
    };
    if (typeof raw?.name !== "string" || !raw.name.trim() || !Array.isArray(raw.files)) {
      throw new Error("The skill marketplace returned an invalid package.");
    }
    let files: SkillPackageFile[] = [];
    let totalBytes = 0;
    let encoder = new TextEncoder();
    for (let item of raw.files) {
      let { path, content } = (item ?? {}) as Partial<SkillPackageFile>;
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("The skill marketplace returned an invalid package file.");
      }
      let bytes = encoder.encode(content).length;
      totalBytes += bytes;
      if (bytes > SKILL_PACKAGE_MAX_FILE_BYTES || files.length >= SKILL_PACKAGE_MAX_FILES ||
          totalBytes > SKILL_PACKAGE_MAX_TOTAL_BYTES) {
        throw new Error("The skill package exceeds the size limits.");
      }
      files.push({ path, content });
    }
    let pkg: SkillPackage = {
      title: raw.name.trim().slice(0, 120),
      description: (typeof raw.description === "string" ? raw.description : "").slice(0, 1024),
      files,
    };

    for (let [vendorId, vendor] of this.vendors) {
      try {
        if ((await vendor.describe()).installsSkillPackages !== true) continue;
      } catch (err) {
        logger.warn("failed to describe vendor while installing a skill package", {
          event: "gatekeeper.skills.install.describe.failed", gatekeeperId: vendorId, error: err,
        });
        continue;
      }
      await (vendor as unknown as SkillInstallerStub).installSkillPackage(pkg);
      return;
    }
    throw new Error("No integration on this deployment can store skill packages.");
  }

  // --- AI Gateway models ---

  // The gateway's configuration. Throws outside AI Gateway mode, which has no models to manage.
  #requireGateway(): AiGatewayConfig {
    let gateway = getAiGatewayConfig(this.env);
    if (!gateway) throw new Error("This deployment does not provide models through AI Gateway.");
    return gateway;
  }

  /**
   * Set how a gateway model is offered, atomically (read-modify-write within the DO). The model's
   * default mode is stored as absence, so setting it forgets the override.
   */
  async setGatewayModelMode(modelId: string, mode: GatewayModelMode): Promise<void> {
    await this.#mutateAdminConfig(config => {
      // Built from the config the mutation is handed, which is authoritative; the KV mirror the
      // user-facing paths read can trail it.
      let model = new GatewayModels(this.#requireGateway(), config).get(modelId);
      if (!model) throw new Error(`No such model: ${modelId}`);
      let modes = entriesWithout(config.modelModes, modelId);
      if (mode !== model.defaultMode) modes.push([modelId, mode]);
      return { ...config, modelModes: Object.fromEntries(modes) };
    });
  }

  /**
   * Replace what is set for a gateway model, atomically. Nothing set is stored as absence. The
   * reasoning level is not held to the model's own levels, since a request clamps it to them; the
   * compaction budget is held to the room the model's window leaves for a prompt.
   */
  async setGatewayModelSettings(modelId: string, settings: GatewayModelSettings): Promise<void> {
    await this.#mutateAdminConfig(config => {
      let model = new GatewayModels(this.#requireGateway(), config).get(modelId);
      if (!model) throw new Error(`No such model: ${modelId}`);
      let budget = settings.compactionInputBudget;
      if (budget !== undefined) {
        let { max } = compactionBudgetRange(model);
        if (max <= 0) {
          throw new Error(`The "${model.name}" model's context window leaves no room for a ` +
              "compaction budget.");
        }
        if (!Number.isSafeInteger(budget) || budget <= 0 || budget > max) {
          throw new Error(`The compaction budget of the "${model.name}" model must be a whole ` +
              `number of tokens from 1 to ${max}.`);
        }
      }
      let entries = entriesWithout(config.modelSettings, modelId);
      let clean = sanitizeModelSettings(settings);
      if (clean) entries.push([modelId, clean]);
      return { ...config, modelSettings: Object.fromEntries(entries) };
    });
  }

  /** Set the reasoning level of the gateway models whose settings give none, or null for none. */
  async setDefaultReasoning(level: ReasoningLevel | null): Promise<void> {
    this.#requireGateway();
    await this.updateAdminConfig({ defaultReasoning: level });
  }

  // The model `model` describes, as it is stored once added. Throws outside AI Gateway mode, and
  // unless the model may be added to `config`: it is well-formed, its provider is one a model may
  // be added under, its ID is free, the runtime knows the model it behaves like, and its window
  // leaves room for a prompt.
  #addableModel(model: GatewayModel, config: AdminConfig): GatewayModel {
    let added = sanitizeAddedModel(model);
    if (!added) {
      throw new Error(
          "Invalid model: it needs an ID and a name, neither over-long, and token limits that " +
          "are positive integers. The ID of a model it behaves like can't be over-long either.");
    }
    new GatewayModels(this.#requireGateway(), config).assertAddable(added);
    if (added.behavesLike !== undefined && !isRuntimeModel(added.provider, added.behavesLike)) {
      throw new Error(`"${added.behavesLike}" is not a model the runtime knows under ` +
          `provider "${added.provider}", so "${added.id}" can't behave like it.`);
    }
    // A response is reserved out of the window, so a reservation that fills it would leave
    // every chat on the model with no prompt to send.
    let { inputBudget, maxOutputTokens } =
        getModelTokenLimits(gatewayModelConfig(addedModel(added)));
    if (inputBudget <= 0) {
      throw new Error(`The "${added.name}" model's context window leaves no room for a ` +
          `prompt: ${maxOutputTokens} tokens of it are reserved for the response. Give the ` +
          "model an output limit under its context window.");
    }
    return added;
  }

  /**
   * Add a gateway model. Whether its ID is free is decided within the mutation, so that two
   * concurrent calls can't both add the same one.
   */
  async addGatewayModel(model: GatewayModel): Promise<void> {
    await this.#mutateAdminConfig(config => {
      let added = this.#addableModel(model, config);
      // The ID was free, so a mode or settings stored under it belonged to a model that has since
      // left.
      return {
        ...config,
        addedModels: [...config.addedModels, added],
        modelModes: Object.fromEntries(entriesWithout(config.modelModes, added.id)),
        modelSettings: Object.fromEntries(entriesWithout(config.modelSettings, added.id)),
      };
    });
  }

  /** Remove an added gateway model, and with it the mode and settings it was given. */
  async removeGatewayModel(modelId: string): Promise<void> {
    this.#requireGateway();
    await this.#mutateAdminConfig(config => {
      let addedModels = config.addedModels.filter(model => model.id !== modelId);
      if (addedModels.length === config.addedModels.length) {
        throw new Error(`No such added model: ${modelId}`);
      }
      // The catalog wins an ID it lists, so a mode or settings stored under one are the suggested
      // model's.
      if (isCatalogModel(modelId)) return { ...config, addedModels };
      return {
        ...config,
        addedModels,
        modelModes: Object.fromEntries(entriesWithout(config.modelModes, modelId)),
        modelSettings: Object.fromEntries(entriesWithout(config.modelSettings, modelId)),
      };
    });
  }

  /**
   * Turn a provider on or off beside the ones the environment lists, which are a floor. Off keeps
   * the modes and settings of the provider's models and the models added under it, all of which
   * return with it.
   */
  async setGatewayProviderEnabled(provider: AiModelProvider, enabled: boolean): Promise<void> {
    await this.#mutateAdminConfig(config => {
      let gateway = this.#requireGateway();
      assertGatewayProvider(provider);
      if (gateway.providers.has(provider)) {
        // On already, with nothing to store.
        if (enabled) return config;
        throw new Error(`Provider "${provider}" is enabled by CF_AI_GATEWAY_PROVIDERS and can ` +
            "only be turned off there.");
      }
      let addedProviders = config.addedProviders.filter(added => added !== provider);
      if (enabled) addedProviders.push(provider);
      return { ...config, addedProviders };
    });
  }

  /**
   * Ask the first suggested model of a provider for a few tokens through the gateway, on behalf
   * of the admin `adminUserId`, and report what happened. A request that fails is a result. The
   * environment alone decides how the request is routed, so a provider that is off can be tested.
   *
   * Nothing is stored and the config mutation queue is not joined, so the other admin calls run
   * while the request is out.
   */
  async testGatewayProvider(provider: AiModelProvider, adminUserId: string)
      : Promise<GatewayModelTest> {
    let gateway = this.#requireGateway();
    assertGatewayProvider(provider);
    let [model] = Object.keys(SUGGESTED_MODELS[provider]);
    if (model === undefined) {
      throw new Error(`Provider "${provider}" has no suggested model to test.`);
    }
    return this.#runTest(gateway, { provider, model, apiToken: "" }, adminUserId, PROVIDER_TEST);
  }

  /**
   * Ask a gateway model for an answer the way a chat turn would, on behalf of the admin
   * `adminUserId`, and report what happened: the request goes out with the config the model runs
   * with, so with the reasoning level in effect for it, under the response cap of a test (see
   * AdminApi.testGatewayModel). A request that fails is a result. A model in any mode can be
   * tested, so that an admin can try one before enabling it.
   *
   * Like testGatewayProvider(), it stores nothing and stays out of the config mutation queue. The
   * config is the authoritative one, which the KV mirror the chats read can trail.
   */
  async testGatewayModel(modelId: string, adminUserId: string): Promise<GatewayModelTest> {
    let gateway = this.#requireGateway();
    let config = new GatewayModels(gateway, this.#config()).runConfig(modelId);
    if (!config) throw new Error(`No such model: ${modelId}`);
    return this.#runTest(gateway, config, adminUserId, MODEL_TEST);
  }

  /**
   * Test the gateway model `model` describes, without adding it and on behalf of the admin
   * `adminUserId`. One request sets no reasoning level and one is at each level the model would
   * list once added, least to most: each is sent as testGatewayModel() sends its own, with the
   * config the added model would run with at that level, and all are sent together. The results
   * come in that order, each with its level, which is null for the request that set none. A
   * request that fails is the result of its level alone. Throws for a model addGatewayModel()
   * would refuse, as it does.
   *
   * Like testGatewayModel(), it stores nothing and stays out of the config mutation queue: the
   * model is held to the config as this call reads it, and whether it may be added is for
   * addGatewayModel() to decide within its own mutation.
   */
  async testNewGatewayModel(model: GatewayModel, adminUserId: string)
      : Promise<GatewayModelLevelTest[]> {
    let gateway = this.#requireGateway();
    let added = addedModel(this.#addableModel(model, this.#config()));
    let levels = gatewayReasoningLevels(
        added.provider, added.id, added.behavesLike, added.capabilities);
    return Promise.all([null, ...levels].map(async reasoning => ({
      ...await this.#runTest(
          gateway, gatewayRunConfig(added, reasoning), adminUserId, MODEL_TEST),
      reasoning,
    })));
  }

  // Send the model `config` describes one prompt through the gateway, as `test` says to and on
  // behalf of the admin `adminUserId`, and report what happened.
  async #runTest(gateway: AiGatewayConfig, config: AiModelConfig, adminUserId: string,
                 test: GatewayTest): Promise<GatewayModelTest> {
    let model = config.model;
    let signal = AbortSignal.timeout(test.timeoutMs);
    let startedAt = Date.now();
    let failure: { status?: number, message: string } | undefined;
    try {
      let handle = getModel(this.env, config,
          { type: "user", id: adminUserId, name: adminUserId });
      await completeText(handle, {
        prompt: "Reply with OK.", maxTokens: Math.min(test.maxTokens, handle.model.maxTokens),
        thinking: test.thinking, signal,
        // The request is the same every time, which a gateway that caches responses would
        // answer without asking the provider.
        headers: { "cf-aig-skip-cache": "true" },
      });
    } catch (error) {
      // The signal is this call's own, so nothing but the timeout aborts it.
      let message = signal.aborted
          ? `The model did not answer within ${test.timeoutMs / 1000} seconds.`
          : error instanceof Error ? error.message : String(error);
      let status = error instanceof AgentTurnError ? error.statusCode : undefined;
      failure = {
        ...(status !== undefined && { status }),
        message: testFailureMessage(message, gateway.apiToken),
      };
    }
    // The failure message stays out of the log: a provider words it.
    logger.info(test.logged, {
      event: test.event, modelId: model, outcome: failure ? "error" : "ok",
      statusCode: failure?.status, durationMs: Date.now() - startedAt,
    });
    return failure ? { model, ok: false, ...failure } : { model, ok: true };
  }

  /** Set whether users may add models of their own to the ones the gateway provides. */
  async setUserModelsEnabled(enabled: boolean): Promise<void> {
    this.#requireGateway();
    await this.updateAdminConfig({ userModelsEnabled: enabled });
  }

  /** Set whether the admin UI may suggest models from models.dev while an admin adds one. */
  async setModelsDevSuggestions(enabled: boolean): Promise<void> {
    this.#requireGateway();
    await this.updateAdminConfig({ modelsDevSuggestions: enabled });
  }

  /** Enable/disable a single gatekeeper resource type atomically (read-modify-write within the DO). */
  async setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    vendorId = vendorId.toLowerCase();
    await this.#mutateAdminConfig(config => {
      let map = { ...config.disabledResources };
      let disabled = new Set(map[vendorId] ?? []);
      if (enabled) disabled.delete(urlPattern); else disabled.add(urlPattern);
      if (disabled.size === 0) delete map[vendorId]; else map[vendorId] = [...disabled];
      return { ...config, disabledResources: map };
    });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<boolean> {
    let previous = this.siteLogoMutationTail;
    let release!: () => void;
    this.siteLogoMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      let current = this.#config();
      if (data === null) {
        await this.updateAdminConfig({ siteLogoConfigured: false });
        try {
          await this.env.BLUEPRINT_CONTENT.delete(SITE_LOGO_R2_KEY);
        } catch (error) {
          logger.warn("failed to delete disabled site logo", {
            event: "site.logo.delete.failed", error,
          });
        }
        return false;
      }

      await this.env.BLUEPRINT_CONTENT.put(SITE_LOGO_R2_KEY, data, {
        httpMetadata: { contentType: "image/png" },
      });
      if (!current.siteLogoConfigured) {
        await this.updateAdminConfig({ siteLogoConfigured: true });
      }
      return true;
    } finally {
      release();
    }
  }

  /**
   * Set a gatekeeper's availability atomically (read-modify-write within the DO). Routes by kind: an
   * auto-provisioning ("ambient") gatekeeper stores its three-state mode in ambientGatekeeperModes
   * (default stored as absence); an ordinary gatekeeper stores a binary enabled/disabled in
   * disabledGatekeepers and rejects the ambient-only 'optional'.
   */
  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let vendor = this.vendors.get(vendorId);
    let ambient = !!vendor && await isAmbientOnly(vendor);
    if (ambient) {
      await this.#mutateAdminConfig(config => {
        let modes = { ...config.ambientGatekeeperModes };
        if (mode === DEFAULT_AMBIENT_GATEKEEPER_MODE) delete modes[vendorId]; else modes[vendorId] = mode;
        return { ...config, ambientGatekeeperModes: modes };
      });
    } else {
      if (mode === "optional") {
        throw new Error(`"${vendorId}" is not an auto-provisioning integration; use 'enabled' or 'disabled'.`);
      }
      await this.#mutateAdminConfig(config => {
        let disabled = new Set(config.disabledGatekeepers);
        if (mode === "enabled") disabled.delete(vendorId); else disabled.add(vendorId);
        return { ...config, disabledGatekeepers: [...disabled] };
      });
    }
  }

  // Admin view of every bound gatekeeper's resource types, annotated with their enabled state.
  // Unlike the user-facing listGatekeeperVendors, this does NOT hide disabled resources (so admins
  // can re-enable them). `adminUserId` is forwarded to getSupportedResources() so RBAC-gated
  // gatekeepers still surface for an admin who has access to them.
  async #listResourceConfig(config: AdminConfig, adminUserId: string): Promise<AdminResourceVendor[]> {
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<AdminResourceVendor | AdminResourceVendor[] | null>[] = [];
    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            // forSetup: a resource that needs setup before anyone can use it still gets its
            // card here, since this is where that setup is entered.
            vendor.getSupportedResources({ userId: adminUserId, forSetup: true }),
          ]);
          // Display metadata shared by both vendor shapes, forwarded for the admin list and
          // detail pages.
          let display = {
            displayName: description.displayName,
            logo: description.logo,
            url: description.url,
            color: description.color,
            tagline: description.tagline,
            description: description.description,
            departments: description.departments,
            credentialScope: description.credentialScope,
          };
          // A setup-capable vendor keeps its row even with no resources: an unconfigured one
          // advertises none, and this row is where the admin enters the setup that changes that.
          // Ambient vendors carry it too: an organization credential (goAML's B2B login) is
          // entered here whether or not the vendor also has a connect flow.
          let setup: { status: VendorSetup["status"]; addition?: { noun: string } } | undefined;
          let setupState: VendorSetup | undefined;
          if (description.supportsAdminSetup === true) {
            setupState = await (vendor as unknown as VendorSetupStub).describeSetup();
            setup = { status: setupState.status };
          }
          if (description.autoProvisionsAccount && supportedResources.length === 0) {
            // Auto-provisioning ("ambient") gatekeeper: a three-state mode, no resources to toggle.
            let mode = ambientGatekeeperMode(config, id, this.env);
            return {
              vendorId: id,
              ...display,
              ...(setup ? { setup } : {}),
              autoProvisions: true,
              ambientMode: mode,
            };
          }
          if (supportedResources.length === 0 && !setup) {
            // Nothing to toggle for this gatekeeper.
            return null;
          }
          let disabled = new Set(config.disabledResources[id] ?? []);
          // Resources presented as connectors of their own (ResourceConnector) become separate
          // entries; the vendor keeps the rest. Each presented one owns the setup inputs it
          // names, and the vendor keeps whatever inputs remain.
          let presented = supportedResources.filter(r => r.connector);
          let own = supportedResources.filter(r => !r.connector);
          let claimedInputs = new Set(presented.flatMap(r => r.connector!.setupInputNames ?? []));
          let ownInputs = setupState
              ? setupState.inputs.map(i => i.name).filter(name => !claimedInputs.has(name))
              : [];
          let configuredInputs = new Set(setupState?.configured.map(c => c.name) ?? []);
          let vendorEnabled = !disabledGatekeeperSet.has(id);
          let entries: AdminResourceVendor[] = [];
          for (let r of presented) {
            let c = r.connector!;
            let inputs = c.setupInputNames ?? [];
            entries.push({
              vendorId: `${id}:${c.id}`,
              displayName: c.displayName,
              logo: c.logo ?? description.logo,
              url: c.url,
              color: c.color ?? description.color,
              tagline: c.tagline,
              description: c.description ?? r.description,
              departments: c.departments,
              credentialScope: c.credentialScope,
              ...(inputs.length > 0 ? {
                setup: { status: inputs.every(name => configuredInputs.has(name)) ? "configured" : "unconfigured" },
                setupInputNames: inputs,
              } : {}),
              virtual: { parentVendorId: id, resourceUrlPattern: r.urlPattern },
              autoProvisions: false,
              enabled: vendorEnabled && !disabled.has(r.urlPattern),
              resources: [],
            });
          }
          let ownSetup = setup && (presented.length === 0 || ownInputs.length > 0) ? setup : undefined;
          // The vendor's own card is where its adding form lives; the connectors presented from
          // its resources keep only their own inputs.
          if (ownSetup && setupState?.addition) ownSetup = { ...ownSetup, addition: setupState.addition };
          if (own.length > 0 || ownSetup) {
            entries.push({
              vendorId: id,
              ...display,
              autoProvisions: false,
              enabled: vendorEnabled,
              resources: own.map(r => ({
                urlPattern: r.urlPattern,
                title: r.title,
                description: r.description,
                icon: r.icon,
                enabled: !disabled.has(r.urlPattern),
              })),
              ...(ownSetup ? { setup: ownSetup } : {}),
              ...(ownSetup && presented.length > 0 ? { setupInputNames: ownInputs } : {}),
            });
          }
          return entries;
        } catch (err) {
          logger.warn("failed to read resource config for gatekeeper", {
            event: "gatekeeper.resource.config.read.failed", gatekeeperId: id, error: err,
          });
          return null;
        }
      })());
    }

    let vendors = (await Promise.all(promises))
        .flatMap(v => v === null ? [] : Array.isArray(v) ? v : [v]);
    // Show auto-provisioned ("ambient") gatekeepers first; preserve the existing order otherwise.
    vendors.sort((a, b) => Number(b.autoProvisions) - Number(a.autoProvisions));
    return vendors;
  }
}

// Whether a vendor is presented and controlled as a purely ambient capability: it auto-provisions
// an account and offers no resources to bind. A vendor that auto-provisions *and* offers resources
// (its provisioned account is how people reach them) is an ordinary vendor with an on/off switch;
// the provisioning policy folds that switch into the account's mode (see provisioning-policy.ts).
async function isAmbientOnly(vendor: Service<GatekeeperVendor>): Promise<boolean> {
  let description = await vendor.describe();
  if (description.autoProvisionsAccount !== true) return false;
  return (await vendor.getSupportedResources()).length === 0;
}

// What the admin portal runs here: admin calls from the control plane (central-admin.ts, which
// checked the call's signature and that the method is one of CENTRAL_ADMIN_METHODS). The
// control plane checked the actor's role, so these methods don't re-check. A thin
// validation+forwarding facade over the AdminSettings DO, the connectors, the channels worker and
// the intelligence directory; never handed to a browser. Settings the portal stores itself
// arrive through the central settings pull instead (central-settings.ts).
@validateRpc()
export class CentralAdminApi extends RpcTarget {
  /**
   * `adminUserId` is the requesting admin's identity, forwarded to gatekeepers when listing the
   * resource catalog (some are RBAC-gated per user) and to the control plane as the acting
   * admin. It's plain data — not a user-DO dependency. `env` reaches the control plane,
   * channels and gatekeeper bindings.
   */
  constructor(private admin: DurableObjectStub<AdminSettings>, private adminUserId: string,
      private env: Cloudflare.Env) {
    super();
  }

  getConnectors(): Promise<AdminResourceVendor[]> {
    return this.admin.getConnectors(this.adminUserId);
  }

  getFormats(): Promise<AdminFormatsView> {
    return this.admin.getFormats();
  }

  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    return this.admin.setResourceEnabled(vendorId, urlPattern, enabled);
  }

  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid integration mode: ${mode}`);
    }
    return this.admin.setGatekeeperMode(vendorId, mode);
  }

  promoteFormat(blueprintId: string): Promise<void> {
    return this.admin.promoteFormat(blueprintId);
  }

  removeFormat(blueprintId: string): Promise<void> {
    return this.admin.removeFormat(blueprintId);
  }

  updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    return this.admin.updateFormat(blueprintId, patch);
  }

  setFormatOrder(blueprintIds: string[]): Promise<void> {
    return this.admin.setFormatOrder(blueprintIds);
  }

  listSkillMarketplace(): Promise<SkillMarketplaceEntry[] | null> {
    return this.admin.listSkillMarketplace();
  }

  installSkillPackage(id: string): Promise<void> {
    return this.admin.installSkillPackage(id);
  }

  // --- Messaging channels (the optional CHANNELS worker; see channels-admin contract) ---

  #requireChannels(): NonNullable<Cloudflare.Env["CHANNELS"]> {
    let channels = this.env.CHANNELS;
    if (!channels) throw new Error("This deployment has no channels worker configured.");
    return channels;
  }

  getChannels(): Promise<ChannelsDescription | null> {
    return describeChannels(this.env);
  }

  async setupTelegram(botToken: string): Promise<{ botUserName: string }> {
    let token = botToken.trim();
    if (!token || token.length > 256) throw new Error("A valid bot token is required.");
    return await this.#requireChannels().setupTelegram(token);
  }

  async clearTelegramSetup(): Promise<boolean> {
    return await this.#requireChannels().clearTelegramSetup();
  }

  async setupEmail(apiKey: string, domain?: string): Promise<void> {
    let key = apiKey.trim();
    if (!key || key.length > 512) throw new Error("A valid API key is required.");
    if (domain !== undefined && domain.length > 253) throw new Error("Invalid domain.");
    await this.#requireChannels().setupEmail(key, domain);
  }

  async clearEmailSetup(): Promise<boolean> {
    return await this.#requireChannels().clearEmailSetup();
  }

  async mintTelegramLinkCode(email: string): Promise<TelegramLinkCode> {
    let normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) throw new Error("A valid email address is required.");
    return await this.#requireChannels().mintTelegramLinkCode(normalized);
  }

  async listTelegramBindings(): Promise<TelegramBinding[]> {
    return await this.#requireChannels().listTelegramBindings();
  }

  async unlinkTelegram(email: string): Promise<boolean> {
    let normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) throw new Error("A valid email address is required.");
    return await this.#requireChannels().unlinkTelegram(normalized);
  }

  async provisionEmailInbox(userEmail: string, username?: string): Promise<EmailInbox> {
    let normalized = userEmail.trim().toLowerCase();
    if (!normalized.includes("@")) throw new Error("A valid email address is required.");
    if (username !== undefined && (username.length > 64 || !username.trim())) {
      throw new Error("Invalid inbox username.");
    }
    return await this.#requireChannels().provisionEmailInbox(normalized, username);
  }

  async listEmailInboxes(): Promise<EmailInbox[]> {
    return await this.#requireChannels().listEmailInboxes();
  }

  async deleteEmailInbox(userEmail: string): Promise<boolean> {
    let normalized = userEmail.trim().toLowerCase();
    if (!normalized.includes("@")) throw new Error("A valid email address is required.");
    return await this.#requireChannels().deleteEmailInbox(normalized);
  }

  // --- Integration setup (runtime admin-entered vendor config; see VendorSetup) ---
  // Same shape as the channels block: validate here, one awaited RPC to the vendor worker,
  // no state in the AdminSettings DO. Secret values transit this facade once and are stored
  // by the vendor itself.

  async #setupVendor(vendorId: string): Promise<VendorSetupStub> {
    let vendor = buildGatekeeperVendorMap(this.env).get(vendorId);
    if (!vendor) throw new Error(`No such integration: ${vendorId}`);
    if ((await vendor.describe()).supportsAdminSetup !== true) {
      throw new Error(`The "${vendorId}" integration does not support admin setup.`);
    }
    return vendor as unknown as VendorSetupStub;
  }

  async getIntegrationSetup(vendorId: string): Promise<VendorSetup> {
    return await (await this.#setupVendor(vendorId)).describeSetup();
  }

  async applyIntegrationSetup(vendorId: string, values: Record<string, string>): Promise<void> {
    let entries = Object.entries(values);
    if (!entries.length) throw new Error("No setup values provided.");
    if (entries.length > SETUP_MAX_VALUES) {
      throw new Error(`At most ${SETUP_MAX_VALUES} setup values are accepted.`);
    }
    for (let [name, value] of entries) {
      if (!SETUP_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid setup value name: ${JSON.stringify(name)}.`);
      }
      if (typeof value !== "string" || !value.trim() || value.length > SETUP_VALUE_MAX_LENGTH) {
        throw new Error(`Setup value "${name}" must be a non-empty string of at most ${SETUP_VALUE_MAX_LENGTH} characters.`);
      }
    }
    await (await this.#setupVendor(vendorId)).applySetup(values);
  }

  async clearIntegrationSetup(vendorId: string, names?: string[]): Promise<void> {
    if (names !== undefined) {
      if (!Array.isArray(names) || names.length === 0 ||
          names.some(name => typeof name !== "string" || !name)) {
        throw new Error("names must be a non-empty list of setup input names.");
      }
    }
    await (await this.#setupVendor(vendorId)).clearSetup(names);
  }

  // --- Intelligence (control plane + each product's gatekeeper setup store) ---
  //
  // Provisioning is the control plane's job (never by hand against a cell). The assistant
  // key it hands back is stored only in the product's gatekeeper per-tenant setup store,
  // through the same service-binding path the admin setup modal uses, so nothing here or in
  // the control plane ever holds it.

  #requireIntelligenceDirectory(): void {
    if (!intelligenceDirectory.hasIntelligenceDirectory(this.env)) {
      throw new Error("This deployment has no central directory configured.");
    }
  }

  #productKind(kind: unknown): IntelligenceProductKind {
    if (kind === undefined) return "organization";
    if (!INTELLIGENCE_PRODUCT_KINDS.includes(kind as IntelligenceProductKind)) {
      throw new Error("Unknown Intelligence product.");
    }
    return kind as IntelligenceProductKind;
  }

  // The product's gatekeeper setup stub, or null when its connector is not bound here (a
  // deployment without that gatekeeper, or a product whose connector has not shipped). The
  // overview then reports "off", or "missing-key" while the instance is active.
  async #productVendor(setup: IntelligenceConnectorSetup | null): Promise<VendorSetupStub | null> {
    if (!setup) return null;
    try {
      return await this.#setupVendor(setup.vendorId);
    } catch {
      return null;
    }
  }

  async #productOverview(
    view: intelligenceDirectory.CentralIntelligence, kind: IntelligenceProductKind,
  ): Promise<IntelligenceProductOverview> {
    let instance = intelligenceDirectory.instanceOf(view, kind);
    let setup = INTELLIGENCE_CONNECTORS[kind];
    let connector: IntelligenceProductOverview["connector"] = "off";
    let vendor = await this.#productVendor(setup);
    if (vendor && setup) {
      try {
        let described = await vendor.describeSetup();
        let stored = new Set(described.configured.map(entry => entry.name));
        let complete = setup.required.every(name => stored.has(name));
        if (described.status === "configured" && complete) connector = "connected";
        else if (instance?.status === "active") connector = "missing-key";
      } catch (err) {
        logger.warn(`failed to read the ${kind} intelligence connector setup`, {
          event: "intelligence.setup.read.failed", error: err,
        });
        if (instance?.status === "active") connector = "missing-key";
      }
    } else if (instance?.status === "active") {
      connector = "missing-key";
    }
    return {
      instance,
      connector,
      url: instance?.status === "active" ? instance.wikiUrl : null,
    };
  }

  async #intelligenceOverview(view: intelligenceDirectory.CentralIntelligence): Promise<IntelligenceOverview> {
    let [organization, data] = await Promise.all([
      this.#productOverview(view, "organization"),
      this.#productOverview(view, "data"),
    ]);
    return { credits: view.credits, organization, data };
  }

  async #storeAssistantKey(
    kind: IntelligenceProductKind, instance: IntelligenceInstanceView, assistantKey: string,
  ): Promise<boolean> {
    let setup = INTELLIGENCE_CONNECTORS[kind];
    let vendor = await this.#productVendor(setup);
    if (!vendor || !setup || !instance.mcpUrl) return false;
    try {
      await vendor.applySetup({
        [setup.mcpUrl]: instance.mcpUrl,
        ...(instance.wikiUrl ? { [setup.url]: instance.wikiUrl } : {}),
        [setup.assistantKey]: assistantKey,
      });
      return true;
    } catch (err) {
      // The key is gone once this returns: the overview reports "missing-key" and the panel
      // offers Reconnect, which rotates it on the cell.
      logger.error(`failed to store the ${kind} intelligence assistant key`, {
        event: "intelligence.setup.write.failed", error: err,
      });
      return false;
    }
  }

  async getIntelligenceOverview(): Promise<IntelligenceOverview | null> {
    if (!intelligenceDirectory.hasIntelligenceDirectory(this.env)) return null;
    return this.#intelligenceOverview(await intelligenceDirectory.fetchIntelligence(this.env));
  }

  async provisionIntelligence(kind?: IntelligenceProductKind): Promise<IntelligenceOverview> {
    let product = this.#productKind(kind);
    this.#requireIntelligenceDirectory();
    let { instance, assistantKey } = await intelligenceDirectory.provisionInstance(this.env, product);
    if (assistantKey !== null) await this.#storeAssistantKey(product, instance, assistantKey);
    return this.#intelligenceOverview(await intelligenceDirectory.fetchIntelligence(this.env));
  }

  async deprovisionIntelligence(kind?: IntelligenceProductKind): Promise<IntelligenceOverview> {
    let product = this.#productKind(kind);
    this.#requireIntelligenceDirectory();
    await intelligenceDirectory.deprovisionInstance(this.env, product);
    let vendor = await this.#productVendor(INTELLIGENCE_CONNECTORS[product]);
    if (vendor) {
      await vendor.clearSetup().catch((err: unknown) => {
        logger.warn(`failed to clear the ${product} intelligence connector setup`, {
          event: "intelligence.setup.clear.failed", error: err,
        });
      });
    }
    return this.#intelligenceOverview(await intelligenceDirectory.fetchIntelligence(this.env));
  }

  async reconnectIntelligence(kind?: IntelligenceProductKind): Promise<IntelligenceOverview> {
    let product = this.#productKind(kind);
    this.#requireIntelligenceDirectory();
    let view = await intelligenceDirectory.fetchIntelligence(this.env);
    let instance = intelligenceDirectory.instanceOf(view, product);
    if (instance?.status !== "active") {
      throw new Error(`${INTELLIGENCE_PRODUCT_NAMES[product]} is not provisioned for this workspace.`);
    }
    if (!INTELLIGENCE_CONNECTORS[product]) {
      throw new Error(`The ${INTELLIGENCE_PRODUCT_NAMES[product]} connector is not available in this deployment yet.`);
    }
    let { assistantKey } = await intelligenceDirectory.rotateAssistantKey(this.env, product);
    if (!(await this.#storeAssistantKey(product, instance, assistantKey))) {
      throw new Error("The new assistant key could not be stored. Check that the connector is installed, then reconnect again.");
    }
    return this.#intelligenceOverview(view);
  }

}
