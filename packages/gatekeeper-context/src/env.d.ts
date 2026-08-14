// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // Public-collections snapshot KV.
    CONTEXT_COLLECTIONS: KVNamespace;
    // Optional Git-compatible backing repos for artifact-backed context collections.
    ARTIFACTS?: Artifacts;
    // Optional Workers AI binding for Markdown renditions of uploaded binary documents
    // (document-conversion.ts). Absent ⇒ originals are stored alone, with no rendition.
    WORKERS_AI?: Ai;
    // Comma-separated ids of bundled knowledge packs to seed as public canonical collections
    // (e.g. "company,finance"). Written into the deployment's config by the operator at
    // provisioning time; absent ⇒ no seeding. See knowledge-packs-install.ts.
    KNOWLEDGE_SEED_PACKS?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "ContextCollectionDurableObject"
      | "UserLibraryDurableObject"
      | "LibraryRegistryDurableObject"
      | "ContextGatekeeper";
  }
}
