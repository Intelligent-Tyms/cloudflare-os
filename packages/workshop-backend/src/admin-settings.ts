import { AdminApi, AdminFormat, AdminFormatPatch, AdminModel, AdminResourceVendor, AdminSettingsView, AdminSkill, AiChatAuthorInfo, AiModelConfig, AmbientGatekeeperMode, BannerColor, BillingCreditType, BillingOverview, BillingPlanChangeResult, BillingPlanOption, BlueprintPublicInfo, ChannelsDescription, EmailInbox, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_ORGANIZATION_PROFILE_LENGTH, MAX_SITE_NAME_LENGTH, SUGGESTED_MODELS, SkillMarketplaceEntry, TeamRole, TeamView, TelegramBinding, TelegramLinkCode, isAmbientGatekeeperMode, isBannerColor, isHexColor } from '@gadgets/workshop-shared/api';
import { GatekeeperVendor, SKILL_PACKAGE_MAX_FILES, SKILL_PACKAGE_MAX_FILE_BYTES, SKILL_PACKAGE_MAX_TOTAL_BYTES, SkillPackage, SkillPackageFile } from '@gadgets/workshop-shared/gatekeeper';
import { DurableObject } from 'cloudflare:workers';
import { RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { collection, createTypedStorage } from '@gadgets/typed-storage';
import { createWorkshopLogger } from "./observability";
import { ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, parseBlueprintKvRecord, readBlueprintKvRecord, sanitizeBlueprintOutput, serializeFeaturedBlueprints } from './blueprint-archive.js';
import { AdminConfig, DEFAULT_ADMIN_CONFIG, FormatCuration, MAX_AGENT_HINT, defaultOutputFormatId, listPromotedFormats, reorderFormats, sanitizeOutputOverrides, serializeAdminConfig } from './admin-config.js';
import { SITE_LOGO_R2_KEY, siteLogoImage, validateSiteLogo } from './site-logo.js';
import { ambientGatekeeperMode, DEFAULT_AMBIENT_GATEKEEPER_MODE } from './provisioning-policy.js';
import { buildGatekeeperVendorMap } from './auth/auth-vendors.js';
import { UserDurableObject, type UserAiModelRecord } from './user.js';
import { getAiGatewayConfig } from './ai-gateway.js';
import { formatBlueprintsManifestVersion, installFormatBlueprints } from './format-blueprints.js';
import { FORMAT_BLUEPRINTS } from './generated/format-blueprints.js';
import * as teamDirectory from './team-directory.js';
import * as billingDirectory from './billing-directory.js';

const logger = createWorkshopLogger("workshop.admin.settings");

// listDeploymentSkills/installSkillPackage are optional on GatekeeperVendor (like createAccount):
// callers gate on the VendorDescription flags and view the stub through the Required shape, since
// RPC stub types don't narrow optional methods.
type SkillListerStub = Required<Pick<GatekeeperVendor, "listDeploymentSkills">>;
type SkillInstallerStub = Required<Pick<GatekeeperVendor, "installSkillPackage">>;

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

function makeAdminSettingsStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      // Mirror of the currently-featured blueprint public records. The user DO owns the
      // authoritative featured bit; this DO keeps the publishable deployment-wide copy.
      featuredBlueprints: collection<BlueprintPublicInfo>()({
        primaryKey: 'id',
      }),
      // Deployment-wide AI models, managed by admins and offered to every user. The stored record
      // carries the provider API token, so raw records never leave the server: users see only the
      // profiles via listModels().
      aiModels: collection<UserAiModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
    },
    singletons: {
      // Authoritative deployment admin config. Mirrored to BLUEPRINTS KV (ADMIN_CONFIG_KEY) so the
      // connect/login/agent hot paths can read it without touching this singleton DO.
      adminConfig: DEFAULT_ADMIN_CONFIG as AdminConfig,

      // Which set of bundled format blueprints has been installed (see
      // formatBlueprintsManifestVersion). Empty means none yet; a mismatch means the repo shipped
      // new or updated ones and they should be reinstalled.
      installedFormatBlueprints: "",

      // Bundled blueprint ids that have already been offered for promotion into
      // AdminConfig.formats. Tracked separately from the install stamp so that promotion happens
      // exactly once per blueprint: an admin who then removes a format keeps it removed, while a
      // deployment that installed before curation existed still gets promoted.
      promotedFormatBlueprints: <string[]>[],

      // Deployment-wide quick model (used for lightweight tasks like chat title generation),
      // referencing an aiModels entry by id. Ignored in AI Gateway mode, which hardcodes its own.
      quickModel: <string | null>null,
    },
  });
}

type AdminSettingsStorage = ReturnType<typeof makeAdminSettingsStorage>;

// Deployment-wide admin settings singleton.
//
// This durable object is always addressed as `getByName("")`. It contains settings that only
// admins may modify. Settings modified through this DO are published to KV so that user requests
// do not have to access the AdminSettings DO directly (which they could otherwise overload), but
// having a singleton DO writing to KV avoids race conditions when updating KV.
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

  // Install the format blueprints bundled with this deployment, if that hasn't already happened
  // for this exact manifest. Idempotent and cheap: an up-to-date deployment does one string
  // comparison and returns.
  //
  // Written straight into the featured mirror rather than through setBlueprintFeatured(), whose
  // authoritative bit lives in the publishing user's DO -- these have no owning user.
  //
  // Callers are coalesced onto one run, or two isolates racing on a fresh deployment both promote
  // the same blueprints, and a duplicated id makes setFormatOrder() reject every reordering.
  ensureFormatBlueprintsInstalled(): Promise<boolean> {
    return this.#installInFlight ??= this.#installFormatBlueprints()
        .finally(() => { this.#installInFlight = undefined; });
  }

  #installInFlight?: Promise<boolean>;

  // Resolves true once every bundled blueprint is live. A partial install resolves false rather
  // than throwing: the caller has nothing to handle, but it does need to know to ask again.
  async #installFormatBlueprints(): Promise<boolean> {
    let complete = true;
    let manifestVersion = formatBlueprintsManifestVersion();
    if (this.storage.installedFormatBlueprints.get() !== manifestVersion) {
      let installed = await installFormatBlueprints(this.env);

      if (installed.length > 0) {
        for (let publicInfo of installed) {
          this.storage.featuredBlueprints.put(publicInfo);
        }
        await this.#writeFeaturedSnapshot();
      }

      // Stamped only once the whole manifest is live, so a crash or a single bad archive retries
      // next time. Recording a partial install as complete would strand the entries that failed
      // until the manifest happened to change again.
      complete = installed.length === FORMAT_BLUEPRINTS.length;
      if (complete) {
        this.storage.installedFormatBlueprints.put(manifestVersion);
      }
      logger.info("installed bundled format blueprints", {
        event: "formats.install.complete",
        size: installed.length,
        failureCount: FORMAT_BLUEPRINTS.length - installed.length,
      });
    }

    // Promotion is checked on every run, not just after an install, so a deployment that installed
    // before curation existed still ends up offering its bundled formats.
    await this.#promoteBundledFormats();
    return complete;
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
    let pending = FORMAT_BLUEPRINTS.filter(entry => !promoted.has(entry.blueprintId));
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
      // A deployment-installed blueprint (see format-blueprints.ts) has no owning User DO to hold
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

  // Every read of the stored config goes through here. A config persisted before a field existed
  // is missing that field entirely, so reads must backfill from the defaults or the first
  // deployment to upgrade hits `undefined` on it.
  #config(): AdminConfig {
    return { ...DEFAULT_ADMIN_CONFIG, ...this.storage.adminConfig.get() };
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

  // Merge a partial update into the admin config and mirror it to KV. Callers (AdminApiImpl) validate
  // scalar values; this just persists atomically.
  updateAdminConfig(patch: Partial<AdminConfig>): Promise<void> {
    return this.#mutateAdminConfig(config => ({ ...config, ...patch }));
  }

  // Read all admin-managed settings for the admin UI in one call: the stored config plus the live
  // resource catalog (every bound gatekeeper's resource types annotated with their enabled state).
  //
  // `adminUserId` is the requesting admin's user id (email/username), forwarded to each gatekeeper's
  // getSupportedResources(). Most gatekeepers ignore it, but RBAC-gated ones (e.g. the internal GTM
  // Data gatekeeper) only reveal their resources to users with the right permission — so without it
  // they'd be hidden from the admin Gatekeepers tab.
  async getSettings(adminUserId: string): Promise<AdminSettingsView> {
    let config = this.#config();
    return {
      signupsEnabled: config.signupsEnabled,
      siteName: config.siteName,
      siteLogo: siteLogoImage(config.siteLogoConfigured),
      instanceInstructions: config.instanceInstructions,
      organizationProfile: config.organizationProfile,
      announcement: config.announcement,
      banner: config.banner,
      accentColor: config.accentColor,
      resourceVendors: await this.#listResourceConfig(config, adminUserId),
      formats: await this.#listFormatConfig(config),
      skills: await this.#listSkillConfig(config),
      models: this.#listModelConfig(config),
      channels: await describeChannels(this.env),
    };
  }

  // --- Deployment AI models ---

  // The model catalog offered to every user. Several callers treat the first entry as the
  // default model, so ordering is part of the contract.
  //
  // Platform AI Gateway mode is platform-catalog-only: the curated gateway list is the whole
  // catalog, and admin-added BYOK records are ignored entirely -- hidden here and refused at
  // resolve (user.ts getChatContext) -- until the teardown release purges them. Outside gateway
  // mode (self-hosted BYOK deployments), the admin-added records are the catalog.
  async listModels(): Promise<AiChatAuthorInfo[]> {
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      let disabled = new Set(this.#config().disabledModels);
      return gwConfig.getModelList(disabled);
    }
    return [...this.storage.aiModels.list()].map(model => model.profile);
  }

  // Admin view of the platform AI Gateway model catalog joined with the deployment's curation,
  // or null outside gateway mode (the panel then manages BYOK models instead). Every catalog
  // entry appears, disabled ones included; a disabled id that has since left the catalog is kept
  // and flagged `missing` so the admin can clear it. Catalog order is preserved (it is also the
  // picker order, and the first enabled entry is the default model).
  #listModelConfig(config: AdminConfig): AdminModel[] | null {
    let gwConfig = getAiGatewayConfig(this.env);
    if (!gwConfig) return null;

    let disabled = new Set(config.disabledModels);
    let result: AdminModel[] = [];
    let seen = new Set<string>();
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (!gwConfig.providers.has(provider)) continue;
      for (let [id, model] of Object.entries(models)) {
        seen.add(id);
        result.push({
          id,
          name: model.name,
          provider: provider as AdminModel["provider"],
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

  // Enable/disable a single platform-catalog model atomically (read-modify-write within the DO).
  // Enabling is also how a stale (`missing`) curation entry is cleared: the disabled set is the
  // whole state.
  async setModelEnabled(id: string, enabled: boolean): Promise<void> {
    if (!getAiGatewayConfig(this.env)) {
      throw new Error("Model curation requires AI Gateway mode.");
    }
    await this.#mutateAdminConfig(config => {
      let disabled = new Set(config.disabledModels);
      if (enabled) disabled.delete(id); else disabled.add(id);
      return { ...config, disabledModels: [...disabled] };
    });
  }

  // Raw stored record, INCLUDING the provider API token. For server-side chat-context resolution
  // only -- never exposed through AdminApiImpl.
  async getModelRecord(id: string): Promise<UserAiModelRecord | null> {
    return this.storage.aiModels.get(id) ?? null;
  }

  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    // Platform gateway mode has no BYOK: the platform holds the keys, and admins curate the
    // catalog with setModelEnabled instead of adding models.
    if (getAiGatewayConfig(this.env)) {
      throw new Error(
          "This deployment's models are platform-managed. Enable or disable them under " +
          "Admin → AI models.");
    }

    profile.type = "agent";
    this.storage.aiModels.put({profile, config});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting built-in suggested models.
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
        if (gwConfig.providers.has(provider) && id in models) {
          throw new Error(`Cannot delete built-in model "${models[id].name}".`);
        }
      }
    }

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  // The quick-model id, or null when unset or pointing at a since-deleted model.
  async getQuickModelId(): Promise<string | null> {
    let id = this.storage.quickModel.get();
    return id && this.storage.aiModels.get(id) ? id : null;
  }

  // Resolved quick-model record (includes the API token) for chat-context assembly; server-side
  // only, like getModelRecord.
  async getQuickModelRecord(): Promise<UserAiModelRecord | null> {
    let id = this.storage.quickModel.get();
    return (id ? this.storage.aiModels.get(id) : undefined) ?? null;
  }

  // --- Standard output formats ---

  // Admin view of the promoted formats: the deployment's curation joined with each blueprint, so
  // the panel can show what is being curated and flag entries whose blueprint has been deleted.
  async #listFormatConfig(config: AdminConfig): Promise<AdminFormat[]> {
    let bundled = new Set(FORMAT_BLUEPRINTS.map(entry => entry.blueprintId));

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
    if (FORMAT_BLUEPRINTS.some(entry => entry.blueprintId === blueprintId)) {
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

  // Enable/disable a single agent skill atomically (read-modify-write within the DO). Enabling is
  // also how a stale (`missing`) curation entry is cleared: the disabled set is the whole state.
  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    await this.#mutateAdminConfig(config => {
      let disabled = new Set(config.disabledSkills);
      if (enabled) disabled.delete(name); else disabled.add(name);
      return { ...config, disabledSkills: [...disabled] };
    });
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
    throw new Error("No connector on this deployment can store skill packages.");
  }

  // Enable/disable a single gatekeeper resource type atomically (read-modify-write within the DO).
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

  // Set a gatekeeper's availability atomically (read-modify-write within the DO). Routes by kind: an
  // auto-provisioning ("ambient") gatekeeper stores its three-state mode in ambientGatekeeperModes
  // (default stored as absence); an ordinary gatekeeper stores a binary enabled/disabled in
  // disabledGatekeepers and rejects the ambient-only 'optional'.
  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let vendor = this.vendors.get(vendorId);
    let autoProvisions = !!vendor && (await vendor.describe()).autoProvisionsAccount === true;
    if (autoProvisions) {
      await this.#mutateAdminConfig(config => {
        let modes = { ...config.ambientGatekeeperModes };
        if (mode === DEFAULT_AMBIENT_GATEKEEPER_MODE) delete modes[vendorId]; else modes[vendorId] = mode;
        return { ...config, ambientGatekeeperModes: modes };
      });
    } else {
      if (mode === "optional") {
        throw new Error(`"${vendorId}" is not an auto-provisioning connector; use 'enabled' or 'disabled'.`);
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

    let promises: Promise<AdminResourceVendor | null>[] = [];
    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources({ userId: adminUserId }),
          ]);
          if (description.autoProvisionsAccount) {
            // Auto-provisioning ("ambient") gatekeeper: a three-state mode, no resources to toggle.
            let mode = ambientGatekeeperMode(config, id);
            return {
              vendorId: id,
              displayName: description.displayName,
              logo: description.logo,
              autoProvisions: true,
              ambientMode: mode,
            };
          }
          if (supportedResources.length === 0) {
            // Nothing to toggle for this gatekeeper.
            return null;
          }
          let disabled = new Set(config.disabledResources[id] ?? []);
          return {
            vendorId: id,
            displayName: description.displayName,
            logo: description.logo,
            autoProvisions: false,
            enabled: !disabledGatekeeperSet.has(id),
            resources: supportedResources.map(r => ({
              urlPattern: r.urlPattern,
              title: r.title,
              description: r.description,
              icon: r.icon,
              enabled: !disabled.has(r.urlPattern),
            })),
          };
        } catch (err) {
          logger.warn("failed to read resource config for gatekeeper", {
            event: "gatekeeper.resource.config.read.failed", gatekeeperId: id, error: err,
          });
          return null;
        }
      })());
    }

    let vendors = (await Promise.all(promises)).filter((v): v is AdminResourceVendor => v !== null);
    // Show auto-provisioned ("ambient") gatekeepers first; preserve the existing order otherwise.
    vendors.sort((a, b) => Number(b.autoProvisions) - Number(a.autoProvisions));
    return vendors;
  }
}

// Capability for managing deployment-wide admin settings, obtained via
// AuthenticatedApi.getAdminApi() (which is null for non-admins). The admin access check happens once
// when the capability is minted in server.ts, so these methods don't re-check. This is a thin
// validation+forwarding facade over the AdminSettings DO — fully user-independent — so a disabled
// gatekeeper/resource can't be re-enabled via a crafted request, and the client never receives a
// stub to the DO's internal methods. Covers branding, agent instructions, signups, and gatekeeper
// connector/resource availability; authentication config stays env-var driven.
@validateRpc()
export class AdminApiImpl extends RpcTarget implements AdminApi {
  // `adminUserId` is the requesting admin's identity, forwarded to gatekeepers when listing the
  // resource catalog (some are RBAC-gated per user) and to the central team directory as the
  // acting admin. It's plain data — not a user-DO dependency. `env` is needed for the team
  // directory client only.
  constructor(private admin: DurableObjectStub<AdminSettings>, private adminUserId: string,
      private env: Cloudflare.Env) {
    super();
  }

  getSettings(): Promise<AdminSettingsView> {
    return this.admin.getSettings(this.adminUserId);
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig({ signupsEnabled: enabled });
  }

  async setSiteName(name: string): Promise<void> {
    if (name.length > MAX_SITE_NAME_LENGTH) {
      throw new Error(`Site name too long (max ${MAX_SITE_NAME_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ siteName: name });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<AdminSettingsView['siteLogo']> {
    if (data !== null) validateSiteLogo(data);
    return siteLogoImage(await this.admin.setSiteLogo(data));
  }

  async setInstanceInstructions(text: string): Promise<void> {
    if (text.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH) {
      throw new Error(`Instructions too long (max ${MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ instanceInstructions: text });
  }

  async setOrganizationProfile(text: string): Promise<void> {
    if (text.length > MAX_ORGANIZATION_PROFILE_LENGTH) {
      throw new Error(
          `Organization profile too long (max ${MAX_ORGANIZATION_PROFILE_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ organizationProfile: text });
  }

  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    return this.admin.setResourceEnabled(vendorId, urlPattern, enabled);
  }

  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid connector mode: ${mode}`);
    }
    return this.admin.setGatekeeperMode(vendorId, mode);
  }

  async setAnnouncement(text: string): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Announcement too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ announcement: text });
  }

  async setBanner(text: string, color: BannerColor): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Banner too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    if (!isBannerColor(color)) {
      throw new Error(`Invalid banner color: ${color}`);
    }
    await this.admin.updateAdminConfig({ banner: { text, color } });
  }

  async setAccentColor(color: string): Promise<void> {
    if (color !== "" && !isHexColor(color)) {
      throw new Error(`Invalid accent color: ${color}`);
    }
    await this.admin.updateAdminConfig({ accentColor: color });
  }

  isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    return this.admin.isBlueprintFeatured(blueprintId);
  }

  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    return this.admin.setBlueprintFeatured(blueprintId, featured);
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

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    // Same bound as the SKILL.md frontmatter schema, so a name that can't belong to any skill
    // can't grow the config; the shape stays free-form since curation may outlive the skill.
    if (!name.trim() || name.length > 64) {
      throw new Error("Invalid skill name.");
    }
    await this.admin.setSkillEnabled(name, enabled);
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<void> {
    // Loose bound like skills: curation may outlive the catalog entry (clearing a `missing` id),
    // so only reject values that can't be a model id at all. Workers AI ids ("@cf/...") are the
    // longest shape.
    if (!id.trim() || id.length > 128) {
      throw new Error("Invalid model id.");
    }
    await this.admin.setModelEnabled(id, enabled);
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

  addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    return this.admin.addModel(profile, config);
  }

  deleteModel(id: string): Promise<void> {
    return this.admin.deleteModel(id);
  }

  setQuickModel(id: string | null): Promise<void> {
    return this.admin.setQuickModel(id);
  }

  // --- Teammates (central team directory; see team-directory.ts) ---

  #requireTeamDirectory(): void {
    if (!teamDirectory.hasTeamDirectory(this.env)) {
      throw new Error("This deployment has no central team directory configured.");
    }
  }

  async getTeam(): Promise<TeamView | null> {
    if (!teamDirectory.hasTeamDirectory(this.env)) return null;
    return teamDirectory.fetchTeam(this.env);
  }

  async inviteTeammate(email: string, role: TeamRole): Promise<TeamView> {
    this.#requireTeamDirectory();
    let normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) throw new Error("A valid email address is required.");
    if (role !== "member" && role !== "admin") throw new Error(`Invalid role: ${role}`);
    return teamDirectory.createTeamInvitation(this.env, normalized, role, this.adminUserId);
  }

  async revokeTeamInvitation(invitationId: string): Promise<TeamView> {
    this.#requireTeamDirectory();
    return teamDirectory.revokeTeamInvitation(this.env, invitationId);
  }

  async resendTeamInvitation(invitationId: string): Promise<TeamView> {
    this.#requireTeamDirectory();
    return teamDirectory.resendTeamInvitation(this.env, invitationId);
  }

  async removeTeammate(email: string): Promise<TeamView> {
    this.#requireTeamDirectory();
    return teamDirectory.removeTeamMember(this.env, email.trim().toLowerCase(), this.adminUserId);
  }

  // --- Billing (central billing directory; see billing-directory.ts) ---

  async getBillingOverview(): Promise<BillingOverview | null> {
    if (!billingDirectory.hasBillingDirectory(this.env)) return null;
    let {entitlements, usage} = await billingDirectory.fetchBillingSummary(this.env);
    return {...entitlements, usage: usage.rows};
  }

  async createTopupCheckout(creditType: BillingCreditType, amountCents: number,
                            successUrl: string, cancelUrl: string): Promise<string> {
    if (!billingDirectory.hasBillingDirectory(this.env)) {
      throw new Error("This deployment has no central billing configured.");
    }
    if (creditType !== "ai" && creditType !== "messaging") {
      throw new Error(`Invalid credit type: ${creditType}`);
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error("The top-up amount must be a positive whole number of cents.");
    }
    for (let url of [successUrl, cancelUrl]) {
      let parsed = URL.parse(url);
      if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
        throw new Error("Return URLs must be http(s) URLs.");
      }
    }
    // Amount bounds are enforced by the billing directory, which owns the policy.
    return billingDirectory.createTopupCheckout(
        this.env, {creditType, amountCents, successUrl, cancelUrl});
  }

  async listBillingPlans(): Promise<BillingPlanOption[]> {
    if (!billingDirectory.hasBillingDirectory(this.env)) return [];
    return billingDirectory.fetchPlans(this.env);
  }

  async changePlan(planCode: string, billingPeriod: "monthly" | "annual",
                   successUrl: string, cancelUrl: string): Promise<BillingPlanChangeResult> {
    if (!billingDirectory.hasBillingDirectory(this.env)) {
      throw new Error("This deployment has no central billing configured.");
    }
    if (!planCode.trim()) throw new Error("A plan code is required.");
    if (billingPeriod !== "monthly" && billingPeriod !== "annual") {
      throw new Error(`Invalid billing period: ${billingPeriod}`);
    }
    for (let url of [successUrl, cancelUrl]) {
      let parsed = URL.parse(url);
      if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
        throw new Error("Return URLs must be http(s) URLs.");
      }
    }
    // Eligibility (seat fit, purchasability, tier) is enforced by the billing directory,
    // which owns the policy; its refusals are end-user-ready messages.
    return billingDirectory.changePlan(
        this.env, {planCode: planCode.trim(), billingPeriod, successUrl, cancelUrl});
  }
}
