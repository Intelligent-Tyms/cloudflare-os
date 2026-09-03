import { RpcStub, RpcTarget, newHttpBatchRpcResponse, newWebSocketRpcSession, RpcSessionOptions } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { JWTPayload } from "jose";
import { PublicApi, AuthenticatedApi, Overseer, GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiGatewayInfo, AiModelProvider, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, ObserverConfigCallback, BlueprintLibrarySummary, BlueprintPublicInfo, BlueprintUserSummary, BlueprintBindingAssignment, AgentSpawnerConfig, WorkpieceId, BLUEPRINT_SCREENSHOT_PATH_PREFIX, BLUEPRINT_SCREENSHOT_R2_PREFIX, blueprintScreenshotUrl, ServerConfig, CloudflareUsageInfo, CloudflareAccountOption, LoginAttempt, GatekeeperAppInfo, AdminApi, GatekeeperVendorInfo, OutputFormatOffer, ListOutputsResult, createOpenGadgetError, getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, AUTH_ERROR_CODES, createAuthError, AssistantProfile, BillingGateInfo, PendingWorkspaceInfo, UserChannelsView, TelegramLinkCode, TeamChatSession, TeamChatTeammate, TeamChatChannelChanges } from '@gadgets/workshop-shared/api';
import type { UiFeatureFlags } from "@gadgets/workshop-shared/feature-flags";
import { getServerConfig } from "./deployment-config.js";
import { isPasswordAuthEnabled, getAuthGatekeeperAllowlist, hasCentralLogin } from "./auth/config.js";
import { getAuthVendorBinding } from "./auth/auth-vendors.js";
import { getUsageInfo } from "./ai-gateway-billing/limits/usage-checker.js";
import { listConnectedAccounts, selectAccount } from "./ai-gateway-billing/cloudflare/connection-service.js";
import { PendingLogin, LoginConnectCallbackImpl } from "./auth/login-flow.js";
import { deploymentOutputForBlueprint, listFormatOffers, readAdminConfig } from "./admin-config.js";

// Re-export the optional-feature Durable Objects + entrypoints so they can be bound in wrangler.
export { PendingLogin, LoginConnectCallbackImpl };
export { UsageCollectorDurableObject } from "./usage-collector.js";
import { usageCollector } from "./usage-collector.js";
import { hasBillingDirectory, requestUpgrade, fetchPendingWorkspace } from "./billing-directory.js";
import { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import { LanguageModelGatekeeper } from "./ai-models";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { AdminSettings, AdminApiImpl } from "./admin-settings.js";
import { BlueprintKvRecord, buildBlueprintArchiveStream, sanitizeBlueprintOutput, parseBlueprintArchive, randomBlueprintId, readBlueprintContent, readBlueprintKvRecord } from "./blueprint-archive.js";
import { listFeaturedWithCatalog, readBlueprintKvRecordViaCatalog } from "./template-catalog.js";
import { GatekeeperConnectCallbackImpl, normalizeUsername, UserDurableObject, CLOUDFLARE_VENDOR_ID } from "./user";
import { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GatekeeperHookLoopback, GadgetTailLoopback, AgentSelfLoopback, TransientStubLoopback } from "./overseer";
import { ExternalMessageGateway } from "./external-message-gateway";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { recordAnalytics } from "./analytics";
import { handleClientErrorRequest } from "./client-errors.js";
import { verifyCfAccessJwt } from "./access.js";
import { importSPKI, jwtVerify } from "jose";
import { resolveUiFeatureFlags } from "./feature-flags";
import { serveSiteLogo, SITE_LOGO_PATH } from "./site-logo.js";
import { createWorkshopLogger } from "./observability";
import { retryOnDoReset, wrapDoStubForTelemetry } from "./do-retry";
import { TeamChat } from "./team-chat.js";
import { isPoolMode, poolModeRefusal } from "./pool-mode.js";

const logger = createWorkshopLogger("workshop.server");

// Set once we've asked the AdminSettings DO to install the bundled format blueprints (see the
// fetch handler), so later requests skip the call. The DO holds the real answer.
let formatBlueprintInstallStarted = false;

function publicBlueprintInfo(id: string, metadata: BlueprintPublicInfo['metadata']): BlueprintPublicInfo {
  return {
    id,
    metadata,
    screenshotUrl: blueprintScreenshotUrl(id, metadata),
  };
}

// Re-export entrypoint types from ai-models.ts.
export { LanguageModelGatekeeper };

// Re-export entrypoint types from admin-settings.ts.
export { AdminSettings };

// Re-export entrypoint types from user.ts.
export { UserDurableObject, GatekeeperConnectCallbackImpl };

// Re-export entrypoint types from overseer.ts.
export { OverseerDurableObject, GatekeeperLoopback, GatekeeperHookLoopback,
    CodeModeTailLoopback, AgentSpawnerGatekeeper, GadgetTailLoopback,
    AgentSelfLoopback, TransientStubLoopback };

// Re-export service-binding entrypoint for external channel integrations.
export { ExternalMessageGateway };

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Set these if using Cloudflare Access for authentication, otherwise username/password is used.
  CF_ACCESS_AUD?: string,  // audience
  CF_ACCESS_ISS?: string,  // team URL, i.e. https://<team>.cloudflareaccess.com
  DEV?: boolean;
  FLAGS?: Flagship;
}

// =======================================================================================

@validateRpc()
class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private env: Env,
      userId: DurableObjectId,
      private abortSession: (reason: Error) => void) {
    super();

    this.#userId = userId;
    this.overseers = this.ctx.exports.OverseerDurableObject;
    this.adminSettings = this.ctx.exports.AdminSettings;
    this.users = this.ctx.exports.UserDurableObject;
  }

  private overseers: DurableObjectNamespace<OverseerDurableObject>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  private users: DurableObjectNamespace<UserDurableObject>;

  #userId: DurableObjectId;

  // Get a stub pointing at the user DO. We create a new stub for every request so that we don't
  // have to worry about detecting when a stub has become broken.
  get #user(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(this.users.get(this.#userId));
  }

  #isAdmin(): boolean {
    let name = this.#userId.name;
    let admins = this.env.ADMINS;

    if (!name || !admins) return false;

    if (typeof admins === "string") {
      // Admins should be a JSON binding of array type, but `.env` doesn't actually let you
      // specify JSON bindings, so we also support a string that parses as JSON array.
      admins = JSON.parse(admins);
    }

    if (!Array.isArray(admins)) {
      throw new TypeError("ADMINS must be configured as an array of usernames.");
    }

    return admins.includes(name);
  }

  // Full admin check: the deploy-time ADMINS list, or (on central-login deployments) an
  // "owner"/"admin" central role carried in the signed handoff token and stored on the user
  // at sign-in. The role isn't admin-mutable state on this deployment — the central service
  // asserts it — so this stays consistent with keeping auth config out of AdminConfig.
  async #isAdminUser(): Promise<boolean> {
    if (this.#isAdmin()) return true;
    if (!hasCentralLogin(this.env)) return false;
    let role = await retryOnDoReset(() => this.#user.getCentralRole());
    return role === "owner" || role === "admin";
  }

  whoami(): Promise<AiChatAuthorInfo> {
    // Pure-read delegations retry once across a user-DO reset (see retryOnDoReset); writes never do.
    return retryOnDoReset(() => this.#user.whoami());
  }
  setOwnDisplayName(name: string): Promise<void> {
    return this.#user.setOwnDisplayName(name);
  }
  changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    return this.#user.changePassword(oldHash, newHash);
  }
  hasPasswordLogin(): Promise<boolean> {
    return retryOnDoReset(() => this.#user.hasPasswordLogin());
  }
  logout(): Promise<void> {
    return this.#user.revokeAllSessions();
  }
  listModels(): Promise<AiChatAuthorInfo[]> {
    return retryOnDoReset(() => this.#user.listModels());
  }
  getQuickModel(): Promise<null | string> {
    return retryOnDoReset(() => this.#user.getQuickModel());
  }

  getPreferredModel(): Promise<string | null> {
    return retryOnDoReset(() => this.#user.getPreferredModel());
  }
  setPreferredModel(id: string | null): Promise<void> {
    return this.#user.setPreferredModel(id);
  }
  isOnboardingCompleted(): Promise<boolean> {
    return retryOnDoReset(() => this.#user.isOnboardingCompleted());
  }
  completeOnboarding(): Promise<void> {
    return this.#user.completeOnboarding();
  }
  getAssistantProfile(): Promise<AssistantProfile | null> {
    return retryOnDoReset(() => this.#user.getAssistantProfile());
  }
  setAssistantProfile(profile: AssistantProfile): Promise<void> {
    return this.#user.setAssistantProfile(profile);
  }

  // Self-service Telegram linking: both methods act only on the caller's own email, so no
  // admin gate — the deep link can't bind anyone else, and unlink can't touch other users.
  async linkMyTelegram(): Promise<TelegramLinkCode> {
    let { channels, email } = this.#requireOwnChannels();
    return await channels.mintTelegramLinkCode(email);
  }

  async unlinkMyTelegram(): Promise<boolean> {
    let { channels, email } = this.#requireOwnChannels();
    return await channels.unlinkTelegram(email);
  }

  #requireOwnChannels() {
    let channels = this.env.CHANNELS;
    let email = this.#userId.name;
    if (!channels || !email) throw new Error("This deployment has no channels worker configured.");
    return { channels, email };
  }

  // A user's own channel connections. Mirrors describeChannels() in admin-settings: a bound
  // but unreachable channels worker reports null (logged, not thrown) so the Channels page
  // degrades to hidden instead of erroring.
  async getMyChannels(): Promise<UserChannelsView | null> {
    let channels = this.env.CHANNELS;
    let email = this.#userId.name;
    if (!channels || !email) return null;
    try {
      return await channels.describeUser(email);
    } catch (error) {
      logger.warn("failed to describe the user's channels", {
        event: "channels.describeUser.failed", error,
      });
      return null;
    }
  }

  getCloudflareUsage(): Promise<CloudflareUsageInfo> {
    return getUsageInfo(this.env, this.#user);
  }

  listCloudflareAccounts(): Promise<CloudflareAccountOption[]> {
    return listConnectedAccounts(this.env, this.#user);
  }

  selectCloudflareAccount(accountId: string): Promise<void> {
    return selectAccount(this.env, this.#user, accountId);
  }

  async setAvatar(data: Uint8Array | null): Promise<void> {
    if (data) {
      if (data.byteLength > 100 * 1024) {
        throw new Error("Avatar too large (max 100 KB)");
      }
      // Verify the data starts with a known image magic-byte header.
      let isJpeg = data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
      let isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47;
      if (!isJpeg && !isPng) {
        throw new Error("Avatar must be a JPEG or PNG image");
      }
    }
    // Avatar data lives in KV (global), not the user's DO storage, so we
    // read/write it directly here to avoid routing through the DO location.
    let userId = this.#userId.name!;
    if (data) {
      await this.env.AVATARS.put(userId, data);
    } else {
      await this.env.AVATARS.delete(userId);
    }
  }
  async getAvatar(userId: string): Promise<Uint8Array | null> {
    // Pool members are unrelated people; nobody's avatar is anyone else's business there.
    if (isPoolMode(this.env) && userId !== this.#userId.name) return null;
    let result = await this.env.AVATARS.get(userId, "arrayBuffer");
    if (!result) return null;
    return new Uint8Array(result);
  }

  getAiConfig(): Promise<AiGatewayInfo> {
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      return Promise.resolve({
        enabled: true,
        enabledProviders: [...gwConfig.providers] as AiModelProvider[],
      });
    } else {
      return Promise.resolve({ enabled: false });
    }
  }

  getUiFeatureFlags(): Promise<UiFeatureFlags> {
    return resolveUiFeatureFlags(this.env, this.#userId.name!);
  }

  async #openGadgetInternal(id: string, shareKey?: string,
                            configureObservers?: RpcStub<ObserverConfigCallback>)
      : Promise<NativeRpcStub<Overseer>> {
    let userId = this.#userId.toString();
    let profileId = this.#userId.name!;
    let overseerId;
    try {
      overseerId = this.overseers.idFromString(id);
    } catch {
      throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
    }
    let overseer = this.overseers.get(overseerId);

    // HACK: Detect loss of the connection to the DO by:
    // - Pass a callback to overseer.open() which it should call when the session is disposed.
    // - Detect if the callback itself is disposed before being called, suggesting the connection
    //   was lost.
    // If the connection is lost, we abort this I/O context, which kills the WebSocket from the
    // client, forcing it to engage its reconnect logic, which should recover.
    // TODO: Implement onRpcBroken() in the built-in RPC system, matching Cap'n Web, and use that
    //   instead.
    // TODO: Consider how to reconnect to one DO without resetting the whole WebSocket. Probably
    //   needs new code on the client side. However, typically a client only ever opens one
    //   gadget at a time (since each tab is a separate client), so it's probably fine for now.
    let closed = false;
    let started = false;
    let notifyClosed = () => {
      closed = true;
    };
    (notifyClosed as any)[Symbol.dispose] = () => {
      if (started && !closed) {
        // this.ctx.abort() would be nicer here, but it is still marked experimental in the
        // workers runtime.
        this.abortSession(new Error(`lost connection to workspace DO (gadget ${id})`));
      }
    }

    let result;
    try {
      result = await overseer.open(userId, profileId, notifyClosed, shareKey, configureObservers);
    } catch (err) {
      // A denial proves this user's listing for the workspace is stale: revocation tries to drop it
      // (refreshAffectedCollaboratorListings), but that push is best-effort. Only catches entries
      // they click; others stay frozen at revocation, as a disconnected collaborator gets no pushes.
      if (getOpenGadgetErrorCode(err) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied) {
        await this.#user.forgetSharedGadget(id);
      }
      throw err;
    }
    started = true;
    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_opened",
      user_id: userId,
      gadget_id: id,
      source: shareKey ? "share_key" : "direct",
    });
    return result;
  }

  async openGadget(id: string, shareKey?: string,
                   configureObservers?: RpcStub<ObserverConfigCallback>)
      : Promise<RpcStub<Overseer>> {
    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return this.#openGadgetInternal(id, shareKey, configureObservers);
  }

  async newGadget(): Promise<RpcStub<Overseer>> {
    let id = this.overseers.newUniqueId().toString();
    await this.#user.newGadget(id, "Untitled Workspace");
    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_created",
      user_id: this.#userId.toString(),
      gadget_id: id,
      source: "blank",
    });
    let result = await this.openGadget(id);
    if (!result) {
      throw new Error("Open failed despite newly-created workspace?");
    }
    return result;
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    return retryOnDoReset(() => this.#user.listGadgets());
  }

  listOutputs(): Promise<ListOutputsResult> {
    return this.#user.listOutputs();
  }

  async listOutputFormats(): Promise<OutputFormatOffer[]> {
    let offers = await listFormatOffers(this.env, await readAdminConfig(this.env));
    // Neither the agent's hint nor the binding details are part of what a user is offered here.
    return offers.map(({agentHint: _agentHint, bindings: _bindings, ...offer}) => offer);
  }

  listGatekeeperVendors(filter?: GatekeeperVendorFilter): Promise<GatekeeperVendorInfo[]> {
    return retryOnDoReset(() => this.#user.listGatekeeperVendors(filter));
  }

  connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<{url: string}> {
    return this.#user.connectAccount(vendorId, resourceUrlPatterns);
  }

  ensureAccountResources(accountId: number, resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return this.#user.ensureAccountResources(accountId, resourceUrlPatterns);
  }

  listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    return retryOnDoReset(() => this.#user.listAddableGatekeepers());
  }

  provisionAmbientAccount(vendorId: string): Promise<void> {
    return this.#user.provisionAmbientAccount(vendorId);
  }

  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    return this.#user.subscribeConnectedAccounts(subscriber, filter);
  }

  disconnectAccount(accountId: number): Promise<void> {
    return this.#user.disconnectAccount(accountId);
  }

  reconnectAccount(accountId: number): Promise<{url: string}> {
    return this.#user.reconnectAccount(accountId);
  }

  startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string) {
    return this.#user.startResourceConfigurator(accountId, resourceUrlPattern);
  }

  async dismissSharedGadget(gadgetId: string): Promise<void> {
    return this.#user.forgetSharedGadget(gadgetId);
  }

  async listOwnBlueprints(): Promise<BlueprintUserSummary[]> {
    return retryOnDoReset(() => this.#user.listBlueprints());
  }

  async getOwnBlueprint(blueprintId: string): Promise<BlueprintUserSummary | null> {
    return retryOnDoReset(() => this.#user.getBlueprint(blueprintId));
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    return retryOnDoReset(() => this.#user.listLibraryBlueprints());
  }

  async setBlueprintPinned(blueprintId: string, pinned: boolean): Promise<void> {
    return this.#user.setBlueprintPinned(blueprintId, pinned);
  }

  async isBlueprintPinned(blueprintId: string): Promise<boolean> {
    return retryOnDoReset(() => this.#user.isBlueprintPinned(blueprintId));
  }

  async listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]> {
    if (isPoolMode(this.env)) return [];
    return (await listFeaturedWithCatalog(this.env)).map(
        blueprint => publicBlueprintInfo(blueprint.id, blueprint.metadata));
  }

  async addBlueprintToLibrary(blueprintId: string): Promise<void> {
    return this.#user.addBlueprintToLibrary(blueprintId);
  }

  async removeBlueprintFromLibrary(blueprintId: string): Promise<void> {
    return this.#user.removeBlueprintFromLibrary(blueprintId);
  }

  isBlueprintInLibrary(blueprintId: string): Promise<{ uploaded: boolean } | null> {
    return retryOnDoReset(() => this.#user.isBlueprintInLibrary(blueprintId));
  }

  async importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string> {
    // The blueprint catalog (KV + R2) is deployment-wide, so a pool has none.
    if (isPoolMode(this.env)) throw poolModeRefusal("Templates");
    let { metadata, contentLength, content } = await parseBlueprintArchive(archive);
    delete metadata.screenshot;
    let blueprintId = randomBlueprintId();
    let r2Key = `${blueprintId}/${metadata.version}`;

    try {
      let fixedLengthStream = new FixedLengthStream(contentLength);

      await Promise.all([
        content.pipeTo(fixedLengthStream.writable),
        this.env.BLUEPRINT_CONTENT.put(r2Key, fixedLengthStream.readable),
      ]);

      let kvRecord: BlueprintKvRecord = {
        metadata,
        ownerId: this.#userId.toString(),
      };

      await this.env.BLUEPRINTS.put(blueprintId, JSON.stringify(kvRecord));

      await this.#user.importBlueprint(blueprintId, metadata);

      recordAnalytics(this.ctx, this.env, {
        event_name: "blueprint_imported",
        user_id: this.#userId.toString(),
        blueprint_id: blueprintId,
      });

      return blueprintId;
    } catch (err) {
      // Try to delete what we uploaded, but don't wait for results becasue there's nothing we
      // can do if they fail, and we already have an error to throw.
      this.env.BLUEPRINTS.delete(blueprintId);
      this.env.BLUEPRINT_CONTENT.delete(r2Key);
      throw err;
    }
  }

  async newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>
  ): Promise<RpcStub<Overseer>> {
    if (isPoolMode(this.env)) throw poolModeRefusal("Templates");
    // 1. Read blueprint from KV (installing it from the catalog first if that is where it lives).
    let kvRecord = await readBlueprintKvRecordViaCatalog(this.env, this.ctx.exports, blueprintId);
    if (!kvRecord) throw new Error("Template not found.");

    // 2. Read gzip-compressed Yjs doc from R2 and decompress.
    let codeBytes = await readBlueprintContent(this.env, blueprintId, kvRecord.metadata.version);
    if (!codeBytes) throw new Error("Template content not found in R2.");

    // 3. Create new Overseer DO (same as newGadget()).
    let id = this.overseers.newUniqueId().toString();
    await this.#user.newGadget(id, kvRecord.metadata.title);
    let overseerResult = await this.#openGadgetInternal(id);

    // 4. Initialize from blueprint code.
    let overseerDo = this.overseers.get(this.overseers.idFromString(id));
    await overseerDo.initializeFromBlueprint(codeBytes, kvRecord.metadata.title,
        deploymentOutputForBlueprint(await readAdminConfig(this.env), blueprintId,
            sanitizeBlueprintOutput(kvRecord.metadata.output)));

    // 5. Create gatekeepers from assignments and bind them into the workspace's (only) gadget.
    let metadata = await overseerResult.getMetadata();
    using gadget = await overseerResult.getGadget(metadata.defaultGadgetId!);

    // Defensively put blueprint bindings into a map (not a raw object) until we've had a chance to
    // validate the names.
    let blueprintBindings = new Map(Object.entries(kvRecord.metadata.bindings));
    let gadgetId = metadata.defaultGadgetId!;

    // Create gatekeepers in two phases: first every non-spawner binding (binding the
    // non-spawnerOnly ones into the gadget, and recording each created gatekeeper's id by
    // binding name), then the agent spawners, whose configs reference the phase-one results
    // symbolically (see SpawnerEnvTarget).
    let createdIds = new Map<string, WorkpieceId>();
    let gkPromises: Promise<void>[] = [];

    for (let [bindingName, assignment] of Object.entries(bindings)) {
      let blueprintBinding = blueprintBindings.get(bindingName);
      if (!blueprintBinding) {
        throw new Error(`Unknown binding name: ${bindingName}`);
      }

      gkPromises.push((async () => {
        let gk;
        if (assignment.type === "gatekeeper") {
          gk = await overseerResult.newGatekeeper(assignment.accountId, assignment.resourceUrl);
          if (!gk) {
            throw new Error(`Failed to create integration for binding "${bindingName}".`);
          }
        } else if (assignment.type === "aiModel") {
          gk = await overseerResult.newAiModelGatekeeper(assignment.modelId);
        } else {
          return;  // agent spawners are created in phase two
        }
        try {
          let id = await gk.getId();
          createdIds.set(bindingName, id);
          // A spawnerOnly binding exists purely to feed some spawner's env; it is not bound
          // into the gadget itself.
          if (!blueprintBinding.spawnerOnly) {
            await gadget.bind(bindingName, id);
          }
        } finally {
          gk[Symbol.dispose]();
        }
      })());
    }

    await Promise.all(gkPromises);

    // Phase two: agent spawners, with the full AgentSpawnerConfig reconstructed -- displayName
    // from the binding's title, modelId from the assignment, and env resolved against the
    // phase-one gatekeepers and the new gadget.
    for (let [bindingName, assignment] of Object.entries(bindings)) {
      if (assignment.type !== "agentSpawner") continue;
      let blueprintBinding = blueprintBindings.get(bindingName);
      if (blueprintBinding?.type !== "agentSpawner") {
        throw new Error(`Binding "${bindingName}" type mismatch.`);
      }

      let env: Record<string, WorkpieceId> = {};
      for (let [envName, target] of Object.entries(blueprintBinding.env)) {
        if (target.type === "gadget") {
          env[envName] = gadgetId;
        } else {
          let id = createdIds.get(target.name);
          if (id === undefined) {
            throw new Error(`Agent spawner binding "${bindingName}" references binding ` +
                `"${target.name}", which was not assigned.`);
          }
          env[envName] = id;
        }
      }

      let config: AgentSpawnerConfig = {
        displayName: blueprintBinding.title,
        modelId: assignment.modelId,
        env,
      };
      using gk = await overseerResult.newAgentSpawnerGatekeeper(config);
      await gadget.bind(bindingName, await gk.getId());
    }

    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_created",
      user_id: this.#userId.toString(),
      gadget_id: id,
      blueprint_id: blueprintId,
      source: "blueprint",
    });

    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return overseerResult;
  }

  async deleteOrphanedBlueprint(blueprintId: string): Promise<void> {
    return this.#user.deleteOwnedBlueprint(blueprintId);
  }

  // --- Gatekeeper management apps ---

  // The management apps available to the current user: their connected accounts that declare a
  // top-level UI (AccountDescription.providesUi). The app id is the gatekeeper's routing id (its
  // vendor id, e.g. "context"), so each app is hosted at /integrations/<vendorId>. UI-providing
  // accounts are auto-provisioned singletons (one per vendor), so the vendor id identifies them.
  async listGatekeeperApps(): Promise<GatekeeperAppInfo[]> {
    // listProvidedAccounts provisions auto-provisioned accounts first (idempotent), so their apps
    // appear in the nav even before the user opens a gadget — in a single round trip.
    let accounts = await this.#user.listProvidedAccounts();
    return accounts
        .filter((account: (typeof accounts)[number]) => account.description.providesUi)
        .map((account: (typeof accounts)[number]) => ({
          id: account.vendorId,
          title: account.description.providesUi!.title,
          icon: account.description.providesUi!.icon,
        }));
  }

  async getGatekeeperApp(id: string): Promise<GatekeeperUiFrame | null> {
    // Self-sufficient: listProvidedAccounts provisions auto-provisioned accounts first (idempotent),
    // so a direct URL load of /integrations/$id works without racing the Header's listGatekeeperApps.
    let user = this.#user;  // one stub for both calls
    let accounts = await user.listProvidedAccounts();
    let app = accounts.find((account: (typeof accounts)[number]) => account.vendorId === id && account.description.providesUi);
    if (!app) return null;
    // isAdmin is supplied fresh per open so admin-gated features reflect the user's current status.
    return user.startAccountAppUi(app.accountId, { isAdmin: await this.#isAdminUser() });
  }

  // --- Team chat ---

  // Null (bubble hidden) unless the deployment has Stream credentials, a tenant slug and a
  // team directory; a Stream outage surfaces as a thrown error the bubble reports.
  getTeamChatSession(): Promise<TeamChatSession | null> {
    let chat = TeamChat.from(this.env);
    if (!chat) return Promise.resolve(null);
    return chat.session(this.#userId.name!);
  }

  listTeamChatTeammates(): Promise<TeamChatTeammate[]> {
    return this.#teamChat().teammates(this.#userId.name!);
  }

  createTeamChatChannel(memberIds: string[], name?: string): Promise<{ cid: string }> {
    return this.#teamChat().createChannel(this.#userId.name!, memberIds, name);
  }

  updateTeamChatChannel(cid: string, changes: TeamChatChannelChanges): Promise<void> {
    return this.#teamChat().updateChannel(this.#userId.name!, cid, changes);
  }

  leaveTeamChatChannel(cid: string): Promise<void> {
    return this.#teamChat().leaveChannel(this.#userId.name!, cid);
  }

  async noteTeamChatMessageSent(cid: string, messageId: string): Promise<void> {
    let chat = TeamChat.from(this.env);
    if (!chat) {
      console.log(JSON.stringify({ event: "discuss_nudge_skip", reason: "no_team_chat", cid }));
      return;
    }
    try {
      let recipients = await chat.recipientsToNudge(this.#userId.name!, cid, messageId);
      for (let email of recipients) {
        let stub = this.users.get(this.users.idFromName(email));
        await stub.scheduleDiscussNudge(cid);
      }
    } catch (err) {
      // Nudges are best-effort: the message itself is already delivered by Stream.
      console.warn("team chat nudge scheduling failed:", err instanceof Error ? err.message : String(err));
    }
  }

  getTeamChatEmailWhenAway(): Promise<boolean> {
    return this.#user.getDiscussEmailWhenAway();
  }

  setTeamChatEmailWhenAway(enabled: boolean): Promise<void> {
    return this.#user.setDiscussEmailWhenAway(enabled);
  }

  #teamChat(): TeamChat {
    let chat = TeamChat.from(this.env);
    if (!chat) throw new Error("Team chat is not available on this deployment.");
    return chat;
  }

  // --- Deployment admin ---

  async amIAdmin(): Promise<boolean> {
    return this.#isAdminUser();
  }

  async getAdminApi(): Promise<RpcStub<AdminApi> | null> {
    if (!(await this.#isAdminUser())) return null;
    // Admin users always have a non-empty user id name (email or username). Forwarded to
    // gatekeepers when listing the resource catalog so RBAC-gated ones still surface for
    // this admin, and to the team directory as the acting admin.
    let adminUserId = this.#userId.name!;
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return new AdminApiImpl(this.adminSettings.getByName(""), adminUserId, this.env,
        usageCollector(this.ctx));
  }

  // --- Central billing (all users) ---

  async getBillingGate(): Promise<BillingGateInfo | null> {
    if (!hasBillingDirectory(this.env)) return null;
    let state = await usageCollector(this.ctx).getBillingState().catch(() => null);
    if (!state) return null;
    return {
      planCode: state.planCode,
      isFreePlan: state.freeDailyLlmCalls != null,
      freeDailyLlmCalls: state.freeDailyLlmCalls,
    };
  }

  async requestPlanUpgrade(): Promise<{ notified: boolean }> {
    if (!hasBillingDirectory(this.env)) {
      throw new Error("This deployment has no central billing configured.");
    }
    let requestedBy = this.#userId.name ?? "A teammate";
    let allowed =
        await usageCollector(this.ctx).claimUpgradeRequestSlot(UPGRADE_REQUEST_COOLDOWN_MS);
    if (!allowed) return { notified: false };
    await requestUpgrade(this.env, { requestedBy });
    return { notified: true };
  }

  async getPendingWorkspace(): Promise<PendingWorkspaceInfo | null> {
    if (!isPoolMode(this.env) || !hasBillingDirectory(this.env)) return null;
    // In pool mode the username is the member's central email (central login handoff).
    let email = this.#userId.name;
    if (!email || !email.includes("@")) return null;
    return await fetchPendingWorkspace(this.env, email).catch(() => null);
  }
}

// One admin notification per workspace per window, shared by all requesters.
const UPGRADE_REQUEST_COOLDOWN_MS = 4 * 60 * 60 * 1000;

async function serveBlueprintScreenshot(env: Env, blueprintId: string): Promise<Response> {
  let object = await env.BLUEPRINT_CONTENT.get(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${blueprintId}`);
  if (!object) return new Response("Not Found", {status: 404});

  let contentType = object.httpMetadata?.contentType;
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    contentType = "image/jpeg";
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// Returned by startGatekeeperLogin(). Wraps the PendingLogin DO so the client awaits the login
// result through a capability (this stub) rather than a guessable id — no login id is ever exposed
// to the client. Disposing the stub (e.g. when the pop-up closes or the component unmounts) cancels
// the in-flight wait and lets the DO be evicted.
@validateRpc()
class LoginAttemptImpl extends RpcTarget implements LoginAttempt {
  constructor(private pending: DurableObjectStub<PendingLogin>) {
    super();
  }

  async wait(): Promise<string> {
    return await this.pending.awaitResult();
  }
}

@validateRpc()
class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserDurableObject>;

  constructor(private ctx: ExecutionContext, private env: Env,
      private abortSession: (reason: Error) => void,
      private accessPayload?: JWTPayload) {
    super();
    this.users = this.ctx.exports.UserDurableObject;
  }

  async ping(): Promise<void> {}

  async getServerConfig(): Promise<ServerConfig> {
    return getServerConfig(this.env);
  }

  async startGatekeeperLogin(vendorId: string): Promise<{ url: string; attempt: RpcStub<LoginAttempt> }> {
    if (!getAuthGatekeeperAllowlist(this.env).includes(vendorId)) {
      throw new Error(`Sign-in via "${vendorId}" is not enabled on this deployment.`);
    }
    const vendor = getAuthVendorBinding(this.env, vendorId);
    if (!vendor) throw new Error(`No such auth integration: ${vendorId}`);
    const desc = await vendor.describe();
    if (!desc.providesAuth) throw new Error(`"${vendorId}" does not provide authentication.`);

    // The PendingLogin DO is the rendezvous between this request and the (separate) OAuth-callback
    // invocation. The client never sees its id — we hand back an `attempt` stub instead.
    const pendingId = this.ctx.exports.PendingLogin.newUniqueId();
    const pending = this.ctx.exports.PendingLogin.get(pendingId);
    const callback = this.ctx.exports.LoginConnectCallbackImpl(
        { props: { pendingId: pendingId.toString(), vendorId } });
    // For most providers, sign-in needs only minimal scopes to verify the user's email (the grant is
    // transient); capability scopes are requested later via an explicit connectAccount. Cloudflare is
    // the exception: signing in with Cloudflare also links AI Gateway billing, so it requests and
    // persists the billing-only scope set up front.
    const options = vendorId === CLOUDFLARE_VENDOR_ID
      ? { scopes: "full" as const, resourceUrlPatterns: [] }
      : { scopes: "auth" as const };
    const { url } = await vendor.connectAccount(callback, options);
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return { url, attempt: new LoginAttemptImpl(pending) };
  }

  async authenticate(token: string): Promise<AuthenticatedApi> {
    let split = token.split(':');
    if (split.length !== 2) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }

    let userId = this.users.idFromName(split[0]);
    await this.users.get(userId).authenticate(split[1]);
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "session_token",
    });
    return new AuthenticatedApiImpl(this.ctx, this.env, userId, this.abortSession);
  }

  // Redeem a central-login handoff token: verify the fleet signature, audience, and expiry, then
  // resolve/create the email-keyed account (same identity scheme as gatekeeper and Access sign-in).
  // Single-use enforcement (jti) lives in the user DO. Mirrors LoginConnectCallbackImpl.complete().
  async loginWithHandoffToken(token: string): Promise<string | null> {
    if (!hasCentralLogin(this.env)) {
      throw new Error("Central login is not enabled on this deployment.");
    }
    let key = await importSPKI(
        `-----BEGIN PUBLIC KEY-----\n${this.env.HANDOFF_PUBLIC_KEY}\n-----END PUBLIC KEY-----`,
        "EdDSA");
    let { payload } = await jwtVerify(token, key, {
      audience: this.env.HANDOFF_AUDIENCE,
      clockTolerance: 5,
    });
    if (typeof payload.sub !== "string" || !payload.sub.includes("@") ||
        typeof payload.jti !== "string" || typeof payload.exp !== "number") {
      throw new Error("Invalid handoff token.");
    }
    // The central service signs other token kinds with the same key pair and audience (e.g.
    // sign-out fan-out tokens), marked by a `purpose` claim. Only purpose-less tokens are
    // login handoffs; anything else must not mint a session.
    if (payload.purpose !== undefined) {
      throw new Error("Invalid handoff token.");
    }

    let email = payload.sub.toLowerCase();
    let userId = this.users.idFromName(email);
    let stub = this.users.get(userId);
    let signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
    // Central role claim ("owner"/"admin" unlock this deployment's /admin area). Unknown
    // values are dropped rather than stored — a future central service can add roles
    // without old workshops mistaking them for privileges.
    let role = payload.role === "owner" || payload.role === "admin" || payload.role === "member"
        ? payload.role : null;
    let secret = await stub.loginOrCreateViaHandoff(
        email, signupsEnabled, payload.jti, payload.exp * 1000, role);
    if (!secret) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "central_handoff",
    });
    return `${email}:${secret}`;
  }

  async authenticateFromCfAccess(): Promise<AuthenticatedApi> {
    if (!this.accessPayload) {
      throw createAuthError(AUTH_ERROR_CODES.notAuthenticatedWithAccess);
    }

    let email = this.accessPayload.email as string;
    let userId = this.users.idFromName(email);
    let signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
    let accountCreated =
        await this.users.get(userId).authenticateFromCfAccess(email, signupsEnabled);
    if (accountCreated) {
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: userId.toString(),
        source: "cf_access",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "cf_access",
    });
    return new AuthenticatedApiImpl(this.ctx, this.env, userId, this.abortSession);
  }

  async login(username: string, passwordHash: Uint8Array): Promise<string | null> {
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }
    if (!isPasswordAuthEnabled(this.env)) {
      throw new Error("Password login is disabled on this deployment. Use a sign-in option.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let token = await this.users.get(id).login(passwordHash);
    if (!token) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: id.toString(),
      source: "password",
    });

    return `${username}:${token}`;
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }
    if (!isPasswordAuthEnabled(this.env)) {
      throw new Error("Password signup is disabled on this deployment. Use a sign-in option.");
    }
    if (!(await readAdminConfig(this.env)).signupsEnabled) {
      throw new Error("New signups are currently disabled on this deployment.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.createAccount(username, displayName, passwordHash);
    if (!token) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "account_created",
      user_id: id.toString(),
      source: "password",
    });

    return `${username}:${token}`;
  }

  async getBlueprint(id: string): Promise<BlueprintPublicInfo | null> {
    if (isPoolMode(this.env)) return null;
    let kvRecord = await readBlueprintKvRecordViaCatalog(this.env, this.ctx.exports, id);
    if (!kvRecord) return null;

    return publicBlueprintInfo(id, kvRecord.metadata);
  }

  async downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>> {
    if (isPoolMode(this.env)) throw poolModeRefusal("Templates");
    let kvRecord = await readBlueprintKvRecordViaCatalog(this.env, this.ctx.exports, id);
    if (!kvRecord) throw new Error("Template not found.");

    let r2Object = await this.env.BLUEPRINT_CONTENT.get(`${id}/${kvRecord.metadata.version}`);
    if (!r2Object) throw new Error("Template content not found in R2.");

    let metadata = { ...kvRecord.metadata };
    delete metadata.screenshot;

    return buildBlueprintArchiveStream(metadata, r2Object.body, r2Object.size);
  }
}

// Central sign-out fan-out: the central identity service posts a short-lived signed token here
// to revoke every local login session for one account (sign-out-everywhere, password reset).
// Same key pair and audience as login handoff tokens, distinguished by the `purpose: "signout"`
// claim — and loginWithHandoffToken rejects any token carrying a `purpose`, so neither token
// kind can stand in for the other. Replays within the ~60s TTL just re-revoke, so no jti
// bookkeeping is needed.
async function handleCentralSignout(req: Request, env: Env, ctx: ExecutionContext)
    : Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!hasCentralLogin(env)) {
    return Response.json({ error: "central login is not enabled" }, { status: 404 });
  }

  let body = await req.json().catch(() => ({})) as { token?: unknown };
  if (typeof body.token !== "string") {
    return Response.json({ error: "token required" }, { status: 400 });
  }

  let key = await importSPKI(
      `-----BEGIN PUBLIC KEY-----\n${env.HANDOFF_PUBLIC_KEY}\n-----END PUBLIC KEY-----`,
      "EdDSA");
  let payload;
  try {
    ({ payload } = await jwtVerify(body.token, key, {
      audience: env.HANDOFF_AUDIENCE,
      clockTolerance: 5,
    }));
  } catch {
    return Response.json({ error: "invalid token" }, { status: 403 });
  }
  if (payload.purpose !== "signout" || typeof payload.sub !== "string" ||
      !payload.sub.includes("@")) {
    return Response.json({ error: "invalid token" }, { status: 403 });
  }

  let email = payload.sub.toLowerCase();
  let userId = ctx.exports.UserDurableObject.idFromName(email);
  await ctx.exports.UserDurableObject.get(userId).revokeAllSessions();
  return Response.json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    if (url.pathname === SITE_LOGO_PATH) {
      return serveSiteLogo(req, env.BLUEPRINT_CONTENT);
    }

    if (url.pathname === "/api/central/signout") {
      return handleCentralSignout(req, env, ctx);
    }

    if (url.pathname.startsWith(BLUEPRINT_SCREENSHOT_PATH_PREFIX)) {
      let blueprintId = url.pathname.slice(BLUEPRINT_SCREENSHOT_PATH_PREFIX.length);
      return serveBlueprintScreenshot(env, blueprintId);
    }

    // Sign-in via authentication gatekeepers happens entirely within each gatekeeper Worker (the
    // OAuth redirect lands on `/gatekeeper/<name>/oauth`); the result is bridged back to the waiting
    // browser via the `attempt` stub from PublicApi.startGatekeeperLogin(). So the backend no longer
    // hosts /auth/* callbacks.

    if (url.pathname === "/api/client-errors") {
      return handleClientErrorRequest(req, env, ctx);
    }

    if (url.pathname === "/api") {
      // Make sure the bundled format blueprints are installed. The AdminSettings DO doesn't wake
      // merely because someone deployed, so the install needs a trigger; hanging it off API
      // traffic means a fresh deployment is provisioned by its first visitor. Fire-and-forget,
      // and the DO is idempotent. Pools skip it: bundled formats are templates, and a pool
      // offers none (the AdminSettings DO refuses as well; this just saves the wake-up).
      if (!formatBlueprintInstallStarted && !isPoolMode(env)) {
        formatBlueprintInstallStarted = true;
        ctx.waitUntil(ctx.exports.AdminSettings.getByName("").ensureFormatBlueprintsInstalled()
            .then((complete: boolean) => {
              // A partial install resolves rather than throwing, and nothing else will call the DO
              // from here, so clearing this is the whole retry: one bad archive would otherwise
              // leave the deployment half-provisioned for as long as the isolate lives.
              if (!complete) formatBlueprintInstallStarted = false;
            })
            .catch((err: unknown) => {
              // Likewise let the next request try again. The DO coalesces concurrent callers, so a
              // retry costs one comparison once it succeeds.
              formatBlueprintInstallStarted = false;
              logger.warn("failed to install bundled format blueprints", {
                event: "formats.install.trigger.failed", error: err,
              });
            }));
      }

      let accessPayload: JWTPayload | undefined;

      if (env.CF_ACCESS_AUD) {
        if (req.headers.get("Origin") !== url.origin) {
          return new Response("Cross-origin API access not allowed.", { status: 403 });
        }

        const payload = await verifyCfAccessJwt(req, env);
        if (!payload) return new Response("Invalid CF access JWT.", { status: 403 });

        if (!payload.email) {
          return new Response("Access JWT didn't specify email address.", { status: 403 });
        }

        accessPayload = payload;
      }

      // HACK: Implement `abortSession` callback by closing the websocket.
      // TODO: When ctx.abort() becomes non-experimental, consider using that instead.
      let abortController = new AbortController();
      let abortSession = (reason: Error) => {
        // Closing the socket fails no invocation, so nothing else logs this.
        logger.warn("aborting api session", { event: "session.abort", error: reason });
        abortController.abort(reason);
      };

      return await newWorkersRpcResponse(req,
          new PublicApiImpl(ctx, env, abortSession, accessPayload),
          { abortSignal: abortController.signal });
    }

    return new Response("Not Found", {status: 404});
  }
} satisfies ExportedHandler<Env>;

// Extend Cap'n Web's RpcSessionOptions with an AbortSignal.
//
// TODO: Consider adding this feature to Cap'n Web. However, we might not actually need it for
//   long: ctx.abort() will soon be available non-experimentally, in which case we can just use
//   that instead.
type ExtendedRpcSessionOptions = RpcSessionOptions & {
  // Abort WebSocket sessions when this AbortSignal is aborted. (No effect on HTTP batch sessions.)
  abortSignal: AbortSignal;
};

// Clone of newWorkersRpcResponse() from Cap'n Web, except the `options` has been extended with
// `abortSignal`.
async function newWorkersRpcResponse(
    request: Request, localMain: any, options?: ExtendedRpcSessionOptions) {
  if (request.method === "POST") {
    let response = await newHttpBatchRpcResponse(request, localMain, options);
    // Since we're exposing the same API over WebSocket, too, and WebSocket always allows
    // cross-origin requests, the API necessarily must be safe for cross-origin use (e.g. because
    // it uses in-band authorization, as recommended in the readme). So, we might as well allow
    // batch requests to be made cross-origin as well.
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain, options);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}

function newWorkersWebSocketRpcResponse(
    request: Request, localMain?: any, options?: ExtendedRpcSessionOptions): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
  }

  let pair = new WebSocketPair();
  let server = pair[0];
  server.accept()
  let stub = newWebSocketRpcSession(server, localMain, options);

  // -- ADDED FOR GADGETS --
  if (options?.abortSignal) {
    if (options.abortSignal.aborted) {
      stub[Symbol.dispose]();
    } else {
      options.abortSignal.addEventListener("abort", () => {
        stub[Symbol.dispose]();
      });
    }
  }
  // -- END ADDED FOR GADGETS --

  return new Response(null, {
    status: 101,
    webSocket: pair[1],
  });
}
