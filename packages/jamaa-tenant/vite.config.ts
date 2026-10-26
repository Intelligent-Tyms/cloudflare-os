// Vite+ per-package settings.
import { defineConfig } from 'vite-plus'
import { vitestTask } from '@gadgets/scripts/vitest-task'

export default defineConfig({
  run: {
    tasks: {
      // Unit tests in workerd, then the merge checks (exports and migrations) under Node.
      test: vitestTask(['vitest run', 'vitest run -c vitest.node.config.ts']),
      /**
       * The upload-ready bundle, exactly as a deploy would send it, into dist/. Builds the parts'
       * validated trees first: the merged entry imports them, not their sources. Context's tree
       * also needs its knowledge packs (KNOWLEDGE_PACKS_DIR picks a fork's own, as for its deploy),
       * which its `build:integration-worker` does not generate, so that tree is validated here.
       */
      bundle: {
        command: [
          'node ../gatekeeper-context/scripts/build-knowledge-packs.mjs',
          'pnpm --dir ../gatekeeper-context exec capnweb-validate build --out .wrangler/validate',
          'wrangler deploy --dry-run --outdir dist',
        ],
        dependsOn: [
          '@gadgets/workshop-backend#build:integration-worker',
          '@gadgets/gatekeeper-context#build:app',
        ],
        cache: false,
      },
    },
  },
})
