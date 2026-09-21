import { defineConfig } from "vitest/config";

/**
 * Only the package's own tests: capnweb-validate copies `__tests__` into `.wrangler/validate`,
 * which vitest would otherwise run a second time.
 */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
