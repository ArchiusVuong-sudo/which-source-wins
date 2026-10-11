import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ColumnMapping } from '../src/shared/types.js';
import { parseCsv } from '../src/server/csv.js';
import { driftReport, parseDate, profileColumn } from '../src/server/drift.js';
import { ROOT } from './helpers.js';

const v1 = JSON.parse(readFileSync(join(ROOT, 'data/mappings/registration.v1.json'), 'utf8')) as ColumnMapping;
const sep = parseCsv(readFileSync(join(ROOT, 'data/sources/registration/2026-09-01.csv'), 'utf8'));
const oct = parseCsv(readFileSync(join(ROOT, 'data/sources/registration/2026-10-01.csv'), 'utf8'));

describe('drift guard', () => {
  it('passes a drop whose header matches the approved mapping', () => {
    expect(driftReport(v1, sep).status).toBe('match');
  });

  it('flags the October drop and maps every renamed column by its values', () => {
    const r = driftReport(v1, oct);
    expect(r.status).toBe('drift');
    expect(r.reordered).toBe(true);
    expect(r.missing).toHaveLength(9);
    expect(Object.fromEntries(r.proposal.map((p) => [p.field, p.column]))).toEqual({
      vin: 'VIN_NO',
      model_year: 'MDL_YR',
      make: 'MAKE_CD',
      model: 'MODEL_DESC',
      colour: 'CLR',
      registration_date: 'REG_DT',
      odometer_km: 'ODO',
      odometer_date: 'ODO_DT',
      province: 'PROV_CD',
    });
    expect(r.dateFormat).toBe('DD/MM/YYYY');
    expect(r.blocking).toEqual([]);
    const vin = r.proposal.find((p) => p.field === 'vin')!;
    expect(vin.evidence.join(' ')).toMatch(/pass the check digit/);
    const reg = r.proposal.find((p) => p.field === 'registration_date')!;
    expect(reg.evidence.join(' ')).toMatch(/REG_DT is on or before ODO_DT/);
  });

  it('proves day-first order only from a part above 12', () => {
    expect(profileColumn('d', 0, ['25/07/2020', '01/02/2021']).dateOrder).toBe('DMY');
    expect(profileColumn('d', 0, ['07/25/2020', '01/02/2021']).dateOrder).toBe('MDY');
    expect(profileColumn('d', 0, ['01/02/2020', '03/04/2021']).dateOrder).toBe('ambiguous');
  });

  it('blocks approval when the date order cannot be proven', () => {
    const t = { header: ['VIN_NO', 'REG_DT'], rows: [['1C6RR7LTXKS612345', '01/02/2020']] };
    const r = driftReport(v1, t);
    expect(r.dateFormat).toBeNull();
    expect(r.blocking).toContain('Date order is ambiguous');
  });

  it('parses dates strictly', () => {
    expect(parseDate('25/07/2020', 'DD/MM/YYYY')).toBe('2020-07-25');
    expect(parseDate('25/07/2020', 'MM/DD/YYYY')).toBeNull();
    expect(parseDate('2026-02-30', 'YYYY-MM-DD')).toBeNull();
  });
});
