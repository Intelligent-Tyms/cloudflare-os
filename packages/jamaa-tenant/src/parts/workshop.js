// workshop-backend exactly as its own deploy bundles it: the capnweb-validate output, built by that
// package's `build:integration-worker` task. Its `@validateRpc()` classes throw if loaded unbuilt.
// Typed by workshop.d.ts, since the tree only type-checks against that package's own Workers types.
export * from "../../../workshop-backend/.wrangler/validate/src/server.ts";
export { default } from "../../../workshop-backend/.wrangler/validate/src/server.ts";
