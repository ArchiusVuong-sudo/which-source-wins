import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '../src/server/platform.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HERO = '1C6RR7LTXKS612345';

/** A fresh platform on an in-memory database and a temp folder for landing and builds. */
export async function openPlatform(): Promise<{ platform: Platform; dir: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'wsw-test-'));
  const platform = await Platform.open({ root: ROOT, dataDir: dir, inMemory: true, vpicDir: join(ROOT, '.data') });
  return {
    platform,
    dir,
    close: async () => {
      await platform.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Approves the quarantined October drop with the proposal as-is and rebuilds. */
export async function approveOctoberAndRebuild(platform: Platform) {
  const drops = await platform.drops();
  const oct = drops.find((d) => d.status === 'quarantined');
  if (!oct) throw new Error('no quarantined drop');
  const { drift } = await platform.drop(oct.id);
  const columns = Object.fromEntries(drift!.proposal.map((p) => [p.field, p.column!]));
  const mapping = await platform.approve(oct.id, columns, drift!.dateFormat!, 'test');
  const build = await platform.rebuild();
  return { oct, drift: drift!, mapping, build };
}
