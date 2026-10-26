// gatekeeper-context exactly as its own deploy bundles it: the capnweb-validate output, built by
// that package's `build:integration-worker` task. Typed by context.d.ts (see workshop.js for why).
export * from "../../../gatekeeper-context/.wrangler/validate/src/index.ts";
export { default } from "../../../gatekeeper-context/.wrangler/validate/src/index.ts";
