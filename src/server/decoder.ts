// Offline VIN pattern decode. Wraps the open-source decoder (bundled NHTSA vPIC data) and turns
// its output into pattern facts: one value per field, the raw manufacturer pattern behind it and
// the VIN positions that pattern reads.

import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createDecoder, type DecodeResult, type PatternMatch } from '@cardog/corgi';
import type { FieldName, PatternEvidence } from '../shared/types.js';
import { titleCase } from './reference.js';
import { checkVin, modelYearFromVin } from './vin.js';

type Decoder = Awaited<ReturnType<typeof createDecoder>>;

/** Unpacks the decoder's bundled vPIC database into our data dir, so nothing lands in the home folder. */
export async function ensureVpicDatabase(dataDir: string): Promise<string> {
  const target = join(dataDir, 'vpic.lite.db');
  if (existsSync(target)) return target;
  mkdirSync(dataDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const pkgMain = require.resolve('@cardog/corgi');
  const gz = join(dirname(pkgMain), 'db', 'vpic.lite.db.gz');
  const tmp = `${target}.${process.pid}.tmp`;
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp));
  renameSync(tmp, target);
  return target;
}

/**
 * VIN positions a vPIC raw pattern reads. The pattern covers positions 4-8, then a pipe, then
 * positions 10-17. A bracket group is one position and `*` is a position the pattern ignores.
 */
export function patternPositions(rawPattern: string | null | undefined): number[] {
  if (!rawPattern) return [];
  const [vds = '', vis = ''] = rawPattern.split('|');
  const read = (part: string, start: number): number[] => {
    const out: number[] = [];
    let pos = start;
    for (let i = 0; i < part.length; i++) {
      const c = part[i]!;
      if (c === '[') {
        const end = part.indexOf(']', i);
        if (end < 0) break;
        out.push(pos);
        i = end;
      } else if (c !== '*') {
        out.push(pos);
      }
      pos++;
    }
    return out;
  };
  return [...read(vds, 4), ...read(vis, 10)];
}

/** A trim or series that names alternatives is a shortlist, not a value. */
export function shortlistOptions(value: string | null | undefined): string[] | null {
  if (!value) return null;
  const parts = value
    .split(/\s*\/\s*|\s*,\s*|\s+&\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 1 ? parts : null;
}

const SHORTLIST_FIELDS: ReadonlySet<FieldName> = new Set<FieldName>(['trim', 'series']);

export interface PatternFact {
  field: FieldName;
  value: string | number | null;
  evidence: PatternEvidence;
}

export interface VinDecode {
  vin: string;
  checkOk: boolean;
  checkExpected: string | null;
  /** What the decoder said, kept for display even when the facts are withheld. */
  decoderSummary: string | null;
  decoderValid: boolean;
  facts: PatternFact[];
  withheldReason: string | null;
}

function findPatterns(patterns: PatternMatch[], element: string, value: string | null | undefined): PatternMatch[] {
  const all = patterns.filter((p) => p.element === element);
  const same = value == null ? all : all.filter((p) => p.value === value);
  return same.length > 0 ? same : all;
}

function evidence(patterns: PatternMatch[], elements: string[], value: string | null | undefined): PatternEvidence {
  const hits = elements.flatMap((e) => findPatterns(patterns, e, elements.length === 1 ? value : undefined));
  const positions = [...new Set(hits.flatMap((p) => patternPositions(p.metadata?.rawPattern)))].sort((a, b) => a - b);
  const raw = hits.map((p) => p.metadata?.rawPattern).filter((r): r is string => !!r);
  return { element: elements.join(' + '), rawPattern: raw.length ? [...new Set(raw)].join('  ') : null, positions, options: null };
}

/** Maps a decoder result to pattern facts. Exported for tests. */
export function factsFromResult(r: DecodeResult): PatternFact[] {
  const patterns = r.patterns ?? [];
  const v = r.components.vehicle;
  const e = r.components.engine;
  const plant = r.components.plant;
  const facts: PatternFact[] = [];
  const push = (field: FieldName, value: string | number | null | undefined, ev: PatternEvidence) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (SHORTLIST_FIELDS.has(field) && typeof value === 'string') {
      const options = shortlistOptions(value);
      if (options) {
        facts.push({ field, value: null, evidence: { ...ev, options } });
        return;
      }
    }
    facts.push({ field, value, evidence: ev });
  };

  if (v) {
    push('make', v.make, evidence(patterns, ['Make'], v.make));
    push('model', v.model, evidence(patterns, ['Model'], v.model));
    push('trim', v.trim, evidence(patterns, ['Trim'], v.trim));
    push('series', v.series, evidence(patterns, ['Series'], v.series));
    push('body', v.bodyStyle, evidence(patterns, ['Body Class'], undefined));
    push('drive', v.driveType, evidence(patterns, ['Drive Type'], v.driveType));
    push('fuel', v.fuelType, evidence(patterns, ['Fuel Type - Primary'], v.fuelType));
  }
  const year = r.components.modelYear?.year ?? modelYearFromVin(r.vin);
  if (year) {
    push('modelYear', year, { element: 'Model Year (position 10)', rawPattern: null, positions: [10], options: null });
  }
  if (e && (e.displacement || e.cylinders)) {
    const parts = [e.displacement ? `${Number(e.displacement).toFixed(1)} L` : null, e.cylinders ? `${e.cylinders} cyl` : null];
    push('engine', parts.filter(Boolean).join(', '), evidence(patterns, ['Displacement (L)', 'Engine Number of Cylinders'], undefined));
  }
  if (plant?.city) {
    push('plant', `${titleCase(plant.city)}, ${titleCase(plant.country.replace(/\s*\(.*\)$/, ''))}`, evidence(patterns, ['Plant City'], plant.city));
  }
  return facts;
}

export class VinPatternDecoder {
  private constructor(private readonly decoder: Decoder) {}

  static async open(dataDir: string): Promise<VinPatternDecoder> {
    const databasePath = await ensureVpicDatabase(dataDir);
    const decoder = await createDecoder({ databasePath, runtime: 'node' });
    return new VinPatternDecoder(decoder);
  }

  async decode(vin: string): Promise<VinDecode> {
    const check = checkVin(vin);
    let result: DecodeResult | null = null;
    try {
      result = await this.decoder.decode(vin, { includePatternDetails: true });
    } catch {
      result = null;
    }
    const v = result?.components.vehicle;
    const decoderSummary = v ? [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') : null;
    const base = {
      vin,
      checkOk: check.checkOk,
      checkExpected: check.expected,
      decoderSummary,
      decoderValid: result?.valid ?? false,
    };
    if (!check.checkOk) {
      // The decoder still decodes a VIN that fails its check digit. We never trust those facts.
      const why = !check.shapeOk
        ? 'VIN has the wrong shape (17 characters, no I, O or Q)'
        : `VIN fails its check digit (position 9 is ${check.actual}, expected ${check.expected})`;
      return { ...base, facts: [], withheldReason: `${why}: pattern facts withheld` };
    }
    if (!result) return { ...base, facts: [], withheldReason: 'decoder returned no result' };
    return { ...base, facts: factsFromResult(result), withheldReason: null };
  }

  async close(): Promise<void> {
    await this.decoder.close();
  }
}
