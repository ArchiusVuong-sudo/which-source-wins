import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA } from '../src/server/sql.js';
import { expectedCheckDigit, isValidVin, oneEditRepair, withCheckDigit } from '../src/server/vin.js';

const CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a * 1103515245 + 12345) % 2 ** 31;
    return a / 2 ** 31;
  };
}

let pg: PGlite;
beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
});
afterAll(async () => {
  await pg.close();
});

describe('SQL and TypeScript agree', () => {
  it('on the check digit for 400 random VINs', async () => {
    const r = rng(7);
    const vins = Array.from({ length: 400 }, () => Array.from({ length: 17 }, () => CHARS[Math.floor(r() * CHARS.length)]).join(''));
    const res = await pg.query<{ v: string; cd: string | null; ok: boolean }>('select v, vin_check_digit(v) as cd, vin_check_ok(v) as ok from unnest($1::text[]) v', [vins]);
    for (const row of res.rows) {
      expect(row.cd).toBe(expectedCheckDigit(row.v));
      expect(row.ok).toBe(isValidVin(row.v));
    }
  });

  it('on one-edit repairs for perturbed VINs', async () => {
    const r = rng(11);
    const pairs: [string, string][] = [];
    for (let i = 0; i < 150; i++) {
      const good = withCheckDigit(Array.from({ length: 17 }, () => CHARS[Math.floor(r() * 23)]).join(''));
      const chars = good.split('');
      const kind = i % 4;
      const p = 9 + Math.floor(r() * 7);
      if (kind === 0) [chars[p], chars[p + 1]] = [chars[p + 1]!, chars[p]!];
      else if (kind === 1) chars[p] = chars[p] === '7' ? '8' : '7';
      else if (kind === 2) chars[p] = 'O';
      else {
        chars[3] = '9';
        chars[p] = 'Z';
      }
      pairs.push([chars.join(''), good]);
    }
    const res = await pg.query<{ bad: string; good: string; rep: { kind: string; positions: number[] } | null }>(
      'select x.bad, x.good, vin_one_edit(x.bad, x.good) as rep from jsonb_to_recordset($1::jsonb) as x(bad text, good text)',
      [JSON.stringify(pairs.map(([bad, good]) => ({ bad, good })))],
    );
    for (const row of res.rows) {
      const ts = oneEditRepair(row.bad, row.good);
      expect(row.rep === null ? null : { kind: row.rep.kind, positions: row.rep.positions }).toEqual(ts === null ? null : { kind: ts.kind, positions: ts.positions });
    }
  });

  it('normalises VINs and model keys', async () => {
    const res = await pg.query<{ a: string; b: string; c: string }>(`select vin_norm(' 1c6-rr7ltxks612345 ') a, model_key('F-150') b, words('2019 Dodge Ram SLT, 4x4!') c`);
    expect(res.rows[0]).toEqual({ a: '1C6RR7LTXKS612345', b: 'F150', c: ' 2019 dodge ram slt 4x4 ' });
  });
});
