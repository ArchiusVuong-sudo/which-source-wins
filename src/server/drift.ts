// Drift guard for CSV drops. A file whose header matches an approved mapping loads. Any other
// header is quarantined with a column-by-column proposal backed by what the values look like.

import type { ColumnMapping, ColumnProfile, ColumnType, DriftReport, MappingProposalRow } from '../shared/types.js';
import type { CsvTable } from './csv.js';
import { ALIASES, COLOURS, PROVINCES, modelKey } from './reference.js';
import { checkVin } from './vin.js';

export type DateFormat = ColumnMapping['dateFormat'];

/** Canonical registration fields and the value type each one needs. */
export const REGISTRATION_FIELDS: Readonly<Record<string, ColumnType>> = {
  vin: 'vin',
  model_year: 'year',
  make: 'make',
  model: 'model',
  colour: 'colour',
  registration_date: 'date',
  odometer_km: 'integer',
  odometer_date: 'date',
  province: 'province',
};

const MAKE_WORDS = new Set([...ALIASES.filter((a) => a.model === null).map((a) => a.alias), ...ALIASES.map((a) => a.make.toLowerCase())]);
const MODEL_KEYS = new Set(ALIASES.flatMap((a) => (a.model ? [modelKey(a.model)!, modelKey(a.alias)!] : [])));
const COLOUR_SET = new Set(COLOURS.map((c) => c.toUpperCase()));
const PROVINCE_SET = new Set(PROVINCES);

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pct = (n: number, d: number) => (d === 0 ? 0 : n / d);

export function parseDate(value: string, format: DateFormat): string | null {
  const v = value.trim();
  let y: number, m: number, d: number;
  if (format === 'YYYY-MM-DD') {
    const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!r) return null;
    [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else {
    const r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (!r) return null;
    const a = Number(r[1]);
    const b = Number(r[2]);
    y = Number(r[3]);
    [d, m] = format === 'DD/MM/YYYY' ? [a, b] : [b, a];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

interface DateStats {
  ymd: number;
  slash: number;
  firstOver12: number;
  secondOver12: number;
  example: string | null;
}

function dateStats(values: string[]): DateStats {
  const s: DateStats = { ymd: 0, slash: 0, firstOver12: 0, secondOver12: 0, example: null };
  for (const v of values) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && parseDate(v, 'YYYY-MM-DD')) s.ymd++;
    const r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (r) {
      s.slash++;
      if (Number(r[1]) > 12) {
        s.firstOver12++;
        s.example ??= v;
      }
      if (Number(r[2]) > 12) s.secondOver12++;
    }
  }
  return s;
}

export function profileColumn(column: string, position: number, values: string[]): ColumnProfile {
  const vals = values.map((v) => v.trim()).filter((v) => v !== '');
  const n = vals.length;
  const checks: string[] = [];
  const shares: Partial<Record<ColumnType, number>> = {};

  const vinShape = vals.filter((v) => /^[A-Z0-9]{17}$/.test(v.toUpperCase())).length;
  if (vinShape > 0) {
    const pass = vals.filter((v) => checkVin(v.toUpperCase()).checkOk).length;
    shares.vin = pct(vinShape, n);
    checks.push(`${vinShape}/${n} have VIN shape (17 characters)`, `${pass}/${n} pass the check digit`);
  }
  const ints = vals.filter((v) => /^\d+$/.test(v)).map(Number);
  if (ints.length === n && n > 0) {
    const min = Math.min(...ints);
    const max = Math.max(...ints);
    if (min >= 1980 && max <= 2030) {
      shares.year = 1;
      checks.push(min === max ? `all ${n} are the year ${min}` : `all ${n} are years from ${min} to ${max}`);
    } else {
      shares.integer = 1;
      checks.push(`all ${n} are whole numbers from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`);
    }
  }
  const ds = dateStats(vals);
  let dateOrder: ColumnProfile['dateOrder'] = null;
  if (ds.ymd === n && n > 0) {
    shares.date = 1;
    dateOrder = 'YMD';
    checks.push(`all ${n} parse as YYYY-MM-DD`);
  } else if (ds.slash === n && n > 0) {
    shares.date = 1;
    if (ds.firstOver12 > 0 && ds.secondOver12 === 0) {
      dateOrder = 'DMY';
      checks.push(`${ds.firstOver12}/${n} have a first part above 12 (e.g. ${ds.example}), so the day comes first`);
    } else if (ds.secondOver12 > 0 && ds.firstOver12 === 0) {
      dateOrder = 'MDY';
      checks.push(`${ds.secondOver12}/${n} have a second part above 12, so the month comes first`);
    } else {
      dateOrder = 'ambiguous';
      checks.push('no part above 12, so day and month order cannot be proven');
    }
  }
  const vocab = (label: ColumnType, hit: (v: string) => boolean, what: string) => {
    const k = vals.filter(hit).length;
    if (k > 0) {
      shares[label] = pct(k, n);
      checks.push(`${k}/${n} are known ${what}`);
    }
  };
  vocab('province', (v) => PROVINCE_SET.has(v.toUpperCase()), 'province codes');
  vocab('colour', (v) => COLOUR_SET.has(v.toUpperCase()), 'colours');
  vocab('make', (v) => MAKE_WORDS.has(words(v)), 'make names or aliases');
  vocab('model', (v) => MODEL_KEYS.has(modelKey(v) ?? ''), 'model names');

  const order: ColumnType[] = ['vin', 'date', 'year', 'integer', 'province', 'colour', 'make', 'model'];
  let detected: ColumnType = 'text';
  let best = 0.8;
  for (const t of order) {
    const s = shares[t] ?? 0;
    if (s > best) {
      best = s;
      detected = t;
    }
  }
  return {
    column,
    position,
    rows: n,
    typeShare: detected === 'text' ? 0 : best,
    distinct: new Set(vals).size,
    samples: [...new Set(vals)].slice(0, 3),
    detectedType: detected,
    checks,
    dateOrder,
  };
}

function nameHint(field: string, column: string): boolean {
  const c = column.toLowerCase();
  const hints: Record<string, string[]> = {
    registration_date: ['reg'],
    odometer_date: ['odo'],
    odometer_km: ['odo', 'km'],
    model_year: ['yr', 'year'],
    vin: ['vin'],
  };
  return (hints[field] ?? []).some((h) => c.includes(h));
}

/**
 * Compares a CSV drop with the approved mapping and proposes how its columns map to our fields.
 * Every proposed column carries the value checks that support it.
 */
export function driftReport(expected: ColumnMapping, table: CsvTable): DriftReport {
  const found = table.header;
  const missing = expected.header.filter((h) => !found.includes(h));
  const added = found.filter((h) => !expected.header.includes(h));
  const status = missing.length === 0 && added.length === 0 && found.join() === expected.header.join() ? 'match' : 'drift';
  const profiles = found.map((col, i) => profileColumn(col, i, table.rows.map((r) => r[i] ?? '')));

  const proposal: MappingProposalRow[] = [];
  const blocking: string[] = [];
  const used = new Set<string>();
  for (const [field, type] of Object.entries(REGISTRATION_FIELDS)) {
    const candidates = profiles.filter((p) => p.detectedType === type && !used.has(p.column));
    let chosen: ColumnProfile | undefined;
    const evidence: string[] = [];
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else if (candidates.length > 1 && type === 'date') {
      // Two date columns: a vehicle is registered before its odometer is read.
      const [a, b] = candidates as [ColumnProfile, ColumnProfile];
      const fmt = (p: ColumnProfile): DateFormat => (p.dateOrder === 'YMD' ? 'YYYY-MM-DD' : p.dateOrder === 'MDY' ? 'MM/DD/YYYY' : 'DD/MM/YYYY');
      let aFirst = 0;
      let compared = 0;
      for (const r of table.rows) {
        const da = parseDate(r[a.position] ?? '', fmt(a));
        const db = parseDate(r[b.position] ?? '', fmt(b));
        if (da && db) {
          compared++;
          if (da <= db) aFirst++;
        }
      }
      const [earlier, later] = aFirst >= compared - aFirst ? [a, b] : [b, a];
      const share = Math.max(aFirst, compared - aFirst);
      chosen = field === 'registration_date' ? earlier : later;
      evidence.push(`${earlier.column} is on or before ${later.column} in ${share}/${compared} rows, so ${earlier.column} is the registration date`);
    } else if (candidates.length > 1) {
      chosen = candidates.find((c) => nameHint(field, c.column)) ?? candidates[0];
      evidence.push(`${candidates.length} columns fit; picked by name`);
    }
    if (!chosen) {
      proposal.push({ field, column: null, confidence: 0, evidence: [`no column has ${type} values`] });
      blocking.push(`No column found for ${field}`);
      continue;
    }
    used.add(chosen.column);
    if (nameHint(field, chosen.column)) evidence.push(`name ${chosen.column} fits ${field}`);
    const confidence = Math.round(chosen.typeShare * (candidates.length > 1 ? 0.9 : 1) * 100) / 100;
    proposal.push({ field, column: chosen.column, confidence, evidence: [...chosen.checks, ...evidence] });
  }

  const dateProfiles = profiles.filter((p) => p.detectedType === 'date');
  const orders = new Set(dateProfiles.map((p) => p.dateOrder));
  let dateFormat: DriftReport['dateFormat'] = null;
  let dateEvidence = '';
  if (orders.has('DMY') && !orders.has('MDY')) {
    dateFormat = 'DD/MM/YYYY';
    const n = dateProfiles.filter((p) => p.dateOrder === 'DMY').map((p) => p.column);
    dateEvidence = `Days above 12 appear in the first part of ${n.join(' and ')}, so dates are DD/MM/YYYY.`;
  } else if (orders.has('MDY') && !orders.has('DMY')) {
    dateFormat = 'MM/DD/YYYY';
    dateEvidence = 'Days above 12 appear in the second part, so dates are MM/DD/YYYY.';
  } else if (orders.size === 1 && orders.has('YMD')) {
    dateFormat = 'YYYY-MM-DD';
    dateEvidence = 'All dates are YYYY-MM-DD.';
  } else {
    dateEvidence = 'Date order cannot be proven from the values.';
    blocking.push('Date order is ambiguous');
  }

  // Reordered: the proposed columns, taken in our field order, are not in file order.
  const positions = proposal.flatMap((p) => (p.column ? [found.indexOf(p.column)] : []));
  const reordered = positions.some((p, i) => i > 0 && p < positions[i - 1]!);

  return {
    status,
    expectedHeader: expected.header,
    expectedColumns: expected.columns,
    foundHeader: found,
    missing,
    added,
    reordered: status === 'drift' && reordered,
    profiles,
    proposal,
    dateFormat,
    dateEvidence,
    blocking,
  };
}
