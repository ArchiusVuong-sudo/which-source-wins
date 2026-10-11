// The planted cases, end to end through landing, drift, matching, survivorship and builds.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '../src/server/platform.js';
import { HERO, approveOctoberAndRebuild, openPlatform } from './helpers.js';

const truth = JSON.parse(readFileSync(new URL('../data/truth.json', import.meta.url), 'utf8')) as {
  vehicles: Record<string, { caseTag: string; registeredProvince: string | null }>;
};
const vinsOf = (tag: string) => Object.entries(truth.vehicles).filter(([, v]) => v.caseTag === tag).map(([vin]) => vin);

let platform: Platform;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ platform, close } = await openPlatform());
});
afterAll(async () => close());

describe('first start', () => {
  it('lands four files and quarantines the October registration drop', async () => {
    const drops = await platform.drops();
    expect(drops).toHaveLength(4);
    expect(drops.every((d) => /^raw\/[a-z_]+\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.(csv|json)$/.test(d.key))).toBe(true);
    const oct = drops.find((d) => d.dropDate === '2026-10-01')!;
    expect(oct.status).toBe('quarantined');
    expect((await platform.builds()).map((b) => b.id)).toEqual([1]);
  });

  it('adds nothing when the same files land again', async () => {
    const before = await platform.drops();
    const r = await platform.land();
    expect(r).toMatchObject({ landed: 0, alreadyLanded: 4 });
    expect(await platform.drops()).toEqual(before);
  });
});

describe('after approving mapping v2 and rebuilding', () => {
  let build: Awaited<ReturnType<typeof approveOctoberAndRebuild>>['build'];
  beforeAll(async () => {
    ({ build } = await approveOctoberAndRebuild(platform));
  });

  it('reports changed, added and removed counts with matching file hashes', async () => {
    expect(build.id).toBe(2);
    expect(build.added).toBe(2);
    expect(build.removed).toBe(0);
    expect(build.changed).toBeGreaterThan(0);
    expect(build.delta.rows).toBe(build.added + build.changed + build.removed);
    for (const kind of ['full', 'delta'] as const) {
      const text = readFileSync(platform.buildFile(build.id, kind), 'utf8');
      expect(createHash('sha256').update(text).digest('hex')).toBe(build[kind].sha256);
      expect(text.trim().split('\n')).toHaveLength(build[kind].rows);
    }
    expect(build.match.cannotLinkViolations).toBe(0);
  });

  it('writes an empty delta when nothing changed', async () => {
    const again = await platform.rebuild();
    expect(again.delta.rows).toBe(0);
    expect(again.full.sha256).toBe(build.full.sha256);
  });

  it('resolves the hero truck from two registry rows, a module read and the repaired listing', async () => {
    const v = await platform.vehicle(HERO);
    const bySource = v.records.map((r) => r.source).sort();
    expect(bySource).toEqual(['listing', 'module_read', 'registration', 'registration']);
    const listing = v.records.find((r) => r.source === 'listing')!;
    expect(listing.vinRaw).toBe('1C6RR7LTXKS612354');
    expect(listing.vinCheck).toBe('fail');
    expect(listing.link.repair).toMatchObject({ kind: 'transposition', positions: [16, 17] });
    expect(listing.withheldDecode).toMatch(/still returned 2019 Ram 1500 Classic DS/);
  });

  it('takes trim from the VIN pattern and keeps the seller words apart', async () => {
    const f = (await platform.vehicle(HERO)).golden.fields;
    expect(f.trim).toMatchObject({ value: 'Classic DS', source: 'vin_pattern', ruleId: 'trim.pattern-only', ruleVersion: 1 });
    expect(f.trim.pattern?.positions).toEqual([4, 5, 6, 7]);
    expect(f.trim.alsoReported).toEqual([]);
    expect(f.observedTrim).toMatchObject({ value: 'SLT', source: 'listing' });
  });

  it('keeps registry and listing make spellings as agreeing also-reported values', async () => {
    const make = (await platform.vehicle(HERO)).golden.fields.make;
    expect(make.value).toBe('Ram');
    expect(make.conflict).toBe(false);
    expect(make.alsoReported.map((a) => [a.source, a.value, a.agrees])).toEqual(
      expect.arrayContaining([
        ['registration', 'RAM', true],
        ['listing', 'Dodge Ram', true],
      ]),
    );
  });

  it('rejects the 48,000 km listing claim as below an earlier reading', async () => {
    const odo = (await platform.vehicle(HERO)).golden.fields.odometerKm;
    expect(odo).toMatchObject({ value: 91_300, source: 'registration', asOf: '2026-09-28', conflict: true });
    const claim = odo.alsoReported.find((a) => a.source === 'listing')!;
    expect(claim.value).toBe(48_000);
    expect(claim.flag).toMatch(/below an earlier reading: 91,300 km/);
    expect(odo.alsoReported.find((a) => a.source === 'module_read')).toMatchObject({ value: 91_240, flag: null, agrees: true });
  });

  it('leaves a field with no source empty and names the sources checked', async () => {
    for (const vin of vinsOf('no-registry')) {
      const p = (await platform.vehicle(vin)).golden.fields.registeredProvince;
      expect(p.value).toBeNull();
      expect(p.source).toBeNull();
      expect(p.reason).toBe('No source has a value. Checked: Registration file.');
    }
  });

  it('turns a multi-valued pattern trim into null with the options as the reason', async () => {
    const vins = (await platform.vehicles()).filter((v) => v.title.includes('Corolla')).map((v) => v.vin);
    const t = (await platform.vehicle(vins[0]!)).golden.fields.trim;
    expect(t.value).toBeNull();
    expect(t.reason).toMatch(/lists alternatives \(L, LE, SE, XLE, XSE\)/);
  });

  it('repairs a registry VIN with the letter O typed for a zero', async () => {
    const [vin] = vinsOf('io-typo');
    const r = (await platform.vehicle(vin!)).records.find((x) => x.link.method === 'repair')!;
    expect(r.source).toBe('registration');
    expect(r.vinCheck).toBe('bad_shape');
    expect(r.link.repair?.kind).toBe('io_fix');
  });

  it('repairs a single mistyped character', async () => {
    const [vin] = vinsOf('substitution-typo');
    const r = (await platform.vehicle(vin!)).records.find((x) => x.link.method === 'repair')!;
    expect(r.link.repair).toMatchObject({ kind: 'substitution', positions: [17] });
  });

  it('links a VIN-less repost when exactly one vehicle on the lot fits', async () => {
    const [vin] = vinsOf('vin-less-repost');
    const r = (await platform.vehicle(vin!)).records.find((x) => x.link.method === 'attribute')!;
    expect(r.vinRaw).toBeNull();
    expect(r.link.blocking).toMatchObject({ seller: 'Lot 11 · Barrie, ON', kmBand: 5000 });
  });

  it('abstains on the VIN-less Ram listing and names both trucks', async () => {
    const u = (await platform.unresolved()).find((x) => x.recordId === 'listing:L-1004')!;
    expect(u.reason).toMatch(/2 vehicles on this lot fit/);
    const [classic, newGen] = vinsOf('classic-vs-new-gen').sort();
    expect(u.candidates.map((c) => c.slice(0, 17)).sort()).toEqual([classic, newGen]);
  });

  it('abstains on the fleet-twin listing VIN that is one edit from both trucks', async () => {
    const u = (await platform.unresolved()).find((x) => x.recordId === 'listing:L-1005')!;
    expect(u.reason).toMatch(/one edit from 2 known VINs/);
    expect(u.candidates.sort()).toEqual(vinsOf('fleet-twins').sort());
  });

  it('flags the registry vs listing colour conflict and keeps the registry value', async () => {
    const [vin] = vinsOf('colour-conflict');
    const c = (await platform.vehicle(vin!)).golden.fields.colour;
    expect(c).toMatchObject({ value: 'Blue', source: 'registration', conflict: true });
    expect(c.flags.join(' ')).toMatch(/Dealer listings say Black/);
  });

  it('never merges two different valid VINs', async () => {
    const q = await platform.quality();
    expect(q.cannotLinkViolations).toBe(0);
  });
});

describe('quality report', () => {
  it('scores pairs against the truth and names each error', async () => {
    const q = await platform.quality();
    expect(q.pairs.precision).toBeLessThan(1);
    expect(q.pairs.recall).toBeLessThan(1);
    expect(q.pairs.tp + q.pairs.fp).toBe(q.pairs.predictedPairs);
    const named = q.errors.map((e) => `${e.kind}:${e.caseTag}`).sort();
    expect(named).toEqual(['false_merge:pasted-vin', 'missed_match:classic-vs-new-gen', 'missed_match:fleet-twins']);
    const pasted = q.errors.find((e) => e.caseTag === 'pasted-vin')!;
    expect(pasted.records[0]?.recordId).toBe('listing:L-1007');
    expect(q.note).toMatch(/not real-world accuracy/);
    const trim = q.fieldAccuracy.find((f) => f.field === 'trim')!.score;
    expect(trim.wrong).toBe(0);
  });
});
