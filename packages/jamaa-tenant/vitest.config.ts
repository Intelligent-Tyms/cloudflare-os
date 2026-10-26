import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { COMPATIBILITY_DATE } from '@gadgets/scripts/worker-config'

/**
 * The handler and env plumbing run inside workerd against stub parts; nothing here loads the real
 * workshop or context (the merge checks in vitest.node.config.ts read their sources instead).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ['nodejs_compat'],
        // A real namespace for the prefixed-KV tests, which must see what KV actually stores.
        kvNamespaces: ['SHARED_KV'],
      },
    }),
  ],
  test: {
    include: ['__tests__/tenant.test.ts', '__tests__/prefixed-kv.test.ts'],
    setupFiles: ['@gadgets/scripts/assert-workerd'],
  },
})
