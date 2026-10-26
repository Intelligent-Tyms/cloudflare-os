// The merged entry must re-export every class each part exports, and its migration history must
// create every SQLite class the parts declare. Both lists are written out by hand (src/index.ts,
// cloudflare.config.ts), so these checks are what stops a class upstream adds from being dropped:
// a missing export breaks `ctx.exports.<Class>` at runtime, a missing class breaks the upload.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import contextConfig, { migrations as contextMigrations } from
  '../../gatekeeper-context/cloudflare.config.ts';
import workshopConfig, { migrations as workshopMigrations } from
  '../../workshop-backend/cloudflare.config.ts';
import tenantConfig, { migrations as tenantMigrations } from '../cloudflare.config.ts';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A module's export names, read by esbuild without bundling (so without building anything).
async function exportsOf(path: string): Promise<string[]> {
  let result = await build({
    entryPoints: [path], bundle: false, write: false, metafile: true, format: 'esm',
    logLevel: 'silent',
  });
  let [output] = Object.values(result.metafile.outputs);
  return output.exports.filter((name) => name !== 'default').toSorted();
}

const sqliteClasses = (history: { new_sqlite_classes?: string[] }[]) =>
  history.flatMap((step) => step.new_sqlite_classes ?? []).toSorted();

describe('jamaa-tenant merge', () => {
  it('re-exports every export of workshop-backend and gatekeeper-context, and nothing else', async () => {
    let workshop = await exportsOf(join(PACKAGES, 'workshop-backend/src/server.ts'));
    let context = await exportsOf(join(PACKAGES, 'gatekeeper-context/src/index.ts'));
    let merged = await exportsOf(join(PACKAGES, 'jamaa-tenant/src/index.ts'));

    expect(workshop.filter((name) => context.includes(name))).toEqual([]);
    expect(merged).toEqual([...workshop, ...context].toSorted());
  });

  it('creates every SQLite class the parts declare', () => {
    expect(sqliteClasses(tenantMigrations))
        .toEqual(sqliteClasses([...workshopMigrations, ...contextMigrations]));
  });

  it('binds everything the parts bind', () => {
    let partBindings = Object.keys({
      ...workshopConfig.worker.env, ...contextConfig.worker.env,
    }).toSorted();
    expect(Object.keys(tenantConfig.worker.env ?? {}).toSorted()).toEqual(partBindings);
  });

  it('carries every compatibility flag of the parts', () => {
    let flags = new Set([
      ...workshopConfig.worker.compatibilityFlags ?? [],
      ...contextConfig.worker.compatibilityFlags ?? [],
    ]);
    expect(new Set(tenantConfig.worker.compatibilityFlags)).toEqual(flags);
  });
});
