import { defineConfig } from 'vitest/config'

/** The merge checks read the parts' sources and configs from disk, so they run under Node. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/merge.test.ts'],
  },
})
