// The merged tenant Worker: router, workshop-backend and gatekeeper-context in one script, for a
// Workers for Platforms dispatch namespace (see tenant.ts). Every class each part exports is
// re-exported here under its own name, so `ctx.exports`, the Durable Object migrations and stored
// RPC stubs all find it where the part expects. Nothing else is exported: the runtime treats every
// export of the main module as an entrypoint. tyms-os composes the channels gatekeeper on top of
// this module with the helpers in tenant.ts.

import * as context from "./parts/context.js";
import * as workshop from "./parts/workshop.js";
import { createTenantHandler, tenantClass } from "./tenant.js";

// workshop-backend

export const PendingLogin = tenantClass(workshop.PendingLogin);
export const LoginConnectCallbackImpl = tenantClass(workshop.LoginConnectCallbackImpl);
export const UsageCollectorDurableObject = tenantClass(workshop.UsageCollectorDurableObject);
export const DecisionModelGatekeeper = tenantClass(workshop.DecisionModelGatekeeper);
export const LanguageModelGatekeeper = tenantClass(workshop.LanguageModelGatekeeper);
export const AdminSettings = tenantClass(workshop.AdminSettings);
export const UserDirectoryDurableObject = tenantClass(workshop.UserDirectoryDurableObject);
export const UserDurableObject = tenantClass(workshop.UserDurableObject);
export const GatekeeperConnectCallbackImpl = tenantClass(workshop.GatekeeperConnectCallbackImpl);
export const GatekeeperUserSelectionExchangeImpl =
    tenantClass(workshop.GatekeeperUserSelectionExchangeImpl);
export const OverseerDurableObject = tenantClass(workshop.OverseerDurableObject);
export const GatekeeperLoopback = tenantClass(workshop.GatekeeperLoopback);
export const GatekeeperHookLoopback = tenantClass(workshop.GatekeeperHookLoopback);
export const CodeModeTailLoopback = tenantClass(workshop.CodeModeTailLoopback);
export const AgentSpawnerGatekeeper = tenantClass(workshop.AgentSpawnerGatekeeper);
export const GadgetTailLoopback = tenantClass(workshop.GadgetTailLoopback);
export const AgentSelfLoopback = tenantClass(workshop.AgentSelfLoopback);
export const ExternalMessageGateway = tenantClass(workshop.ExternalMessageGateway);

// gatekeeper-context

export const ContextCollectionDurableObject = tenantClass(context.ContextCollectionDurableObject);
export const UserLibraryDurableObject = tenantClass(context.UserLibraryDurableObject);
export const LibraryRegistryDurableObject = tenantClass(context.LibraryRegistryDurableObject);
export const GatekeeperVendor = tenantClass(context.GatekeeperVendor);
export const ContextAccount = tenantClass(context.ContextAccount);
export const ContextVerifier = tenantClass(context.ContextVerifier);
export const ContextGatekeeper = tenantClass(context.ContextGatekeeper);

export default createTenantHandler({ workshop: workshop.default, context: context.default });
