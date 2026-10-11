import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VinPatternDecoder, patternPositions, shortlistOptions } from '../src/server/decoder.js';
import { HERO, ROOT } from './helpers.js';

describe('patternPositions', () => {
  it('maps vPIC raw patterns to VIN positions', () => {
    expect(patternPositions('[A-VXYZ12]R[67][A-V]')).toEqual([4, 5, 6, 7]);
    expect(patternPositions('*****|*S')).toEqual([11]);
    expect(patternPositions('****T')).toEqual([8]);
    expect(patternPositions('*R[3579]')).toEqual([5, 6]);
    expect(patternPositions(null)).toEqual([]);
  });
});

describe('shortlistOptions', () => {
  it('splits the three shapes alternatives arrive in', () => {
    expect(shortlistOptions('L/LE/SE/XLE/XSE')).toEqual(['L', 'LE', 'SE', 'XLE', 'XSE']);
    expect(shortlistOptions('XLE / XLE Premium 2WD / XLE FWD (Canada)')).toHaveLength(3);
    expect(shortlistOptions('SEL, Value Edition & Limited')).toEqual(['SEL', 'Value Edition', 'Limited']);
  });
  it('keeps a single value', () => {
    expect(shortlistOptions('Classic DS')).toBeNull();
    expect(shortlistOptions(null)).toBeNull();
  });
});

describe('VinPatternDecoder (offline vPIC)', () => {
  let d: VinPatternDecoder;
  beforeAll(async () => {
    d = await VinPatternDecoder.open(join(ROOT, '.data'));
  });
  afterAll(async () => {
    await d.close();
  });

  it('decodes the hero trim from positions 4-7', async () => {
    const r = await d.decode(HERO);
    const trim = r.facts.find((f) => f.field === 'trim')!;
    expect(r.checkOk).toBe(true);
    expect(trim.value).toBe('Classic DS');
    expect(trim.evidence.positions).toEqual([4, 5, 6, 7]);
    expect(r.facts.find((f) => f.field === 'make')?.value).toBe('Ram');
    expect(r.facts.find((f) => f.field === 'modelYear')).toMatchObject({ value: 2019, evidence: { positions: [10] } });
    expect(r.facts.find((f) => f.field === 'plant')?.evidence.positions).toEqual([11]);
  });

  it('turns a trim that lists alternatives into null with the options', async () => {
    const r = await d.decode('2T1BURHE4KC100001');
    const trim = r.facts.find((f) => f.field === 'trim')!;
    expect(trim.value).toBeNull();
    expect(trim.evidence.options).toEqual(['L', 'LE', 'SE', 'XLE', 'XSE']);
  });

  it('keeps synonym slashes outside trim and series', async () => {
    const r = await d.decode(HERO);
    expect(r.facts.find((f) => f.field === 'drive')?.value).toBe('4WD/4-Wheel Drive/4x4');
  });

  it('withholds every fact when the check digit fails, though the decoder still decodes', async () => {
    const r = await d.decode('1C6RR7LTXKS612354');
    expect(r.checkOk).toBe(false);
    expect(r.facts).toEqual([]);
    expect(r.decoderValid).toBe(true);
    expect(r.decoderSummary).toContain('Classic DS');
    expect(r.withheldReason).toMatch(/check digit/);
  });
});
