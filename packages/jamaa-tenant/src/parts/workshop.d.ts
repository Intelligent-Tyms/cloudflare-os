// The exports of workshop.js the merged entry uses. __tests__/merge.test.ts checks this list
// against workshop-backend's real exports, so a class upstream adds cannot be silently dropped.
import type { TenantClass } from "../tenant.js";

export declare const PendingLogin: TenantClass;
export declare const LoginConnectCallbackImpl: TenantClass;
export declare const UsageCollectorDurableObject: TenantClass;
export declare const DecisionModelGatekeeper: TenantClass;
export declare const LanguageModelGatekeeper: TenantClass;
export declare const AdminSettings: TenantClass;
export declare const UserDirectoryDurableObject: TenantClass;
export declare const UserDurableObject: TenantClass;
export declare const GatekeeperConnectCallbackImpl: TenantClass;
export declare const GatekeeperUserSelectionExchangeImpl: TenantClass;
export declare const OverseerDurableObject: TenantClass;
export declare const GatekeeperLoopback: TenantClass;
export declare const GatekeeperHookLoopback: TenantClass;
export declare const CodeModeTailLoopback: TenantClass;
export declare const AgentSpawnerGatekeeper: TenantClass;
export declare const GadgetTailLoopback: TenantClass;
export declare const AgentSelfLoopback: TenantClass;
export declare const ExternalMessageGateway: TenantClass;

declare const handler: ExportedHandler<Cloudflare.Env>;
export default handler;
