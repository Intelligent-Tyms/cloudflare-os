// The exports of context.js the merged entry uses, checked like workshop.d.ts.
import type { TenantClass } from "../tenant.js";

export declare const ContextCollectionDurableObject: TenantClass;
export declare const UserLibraryDurableObject: TenantClass;
export declare const LibraryRegistryDurableObject: TenantClass;
export declare const GatekeeperVendor: TenantClass;
export declare const ContextAccount: TenantClass;
export declare const ContextVerifier: TenantClass;
export declare const ContextGatekeeper: TenantClass;

declare const handler: ExportedHandler<Cloudflare.Env>;
export default handler;
