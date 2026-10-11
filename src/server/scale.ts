// Scale check: the matcher's blocking query on generated rows in a separate in-memory Postgres,
// planned with EXPLAIN (ANALYZE, BUFFERS) before and after its composite index.
// The server runs this in a worker thread so the app keeps answering while it works.

import { PGlite } from '@electric-sql/pglite';
import type { PlanNode, ScaleReport, ScaleRun } from '../shared/types.js';

export const BLOCKING_QUERY = `select l.id as listing_id, c.id as candidate_id
from record_scale l
join record_scale c
  on c.seller = l.seller and c.make = l.make and c.model = l.model
 and c.model_year = l.model_year and c.km between l.km - 5000 and l.km + 5000
 and c.id <> l.id and c.has_vin
where l.seller = 'S0042' and not l.has_vin`;

interface RawPlan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Total Time': number;
  'Actual Loops': number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Hash Cond'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Join Type'?: string;
  Plans?: RawPlan[];
}

export function toPlanNode(p: RawPlan): PlanNode {
  const detail = p['Index Cond'] ?? p['Hash Cond'] ?? p.Filter ?? null;
  return {
    nodeType: p['Node Type'] + (p['Join Type'] && p['Join Type'] !== 'Inner' ? ` (${p['Join Type']})` : ''),
    relation: p['Relation Name'] ?? null,
    index: p['Index Name'] ?? null,
    actualRows: p['Actual Rows'],
    actualTotalMs: p['Actual Total Time'],
    loops: p['Actual Loops'],
    sharedHit: p['Shared Hit Blocks'] ?? 0,
    sharedRead: p['Shared Read Blocks'] ?? 0,
    detail,
    children: (p.Plans ?? []).map(toPlanNode),
  };
}

async function explain(pg: PGlite, label: string): Promise<ScaleRun> {
  const r = await pg.query<{ 'QUERY PLAN': [{ Plan: RawPlan; 'Execution Time': number; 'Planning Time': number }] }>(
    `explain (analyze, buffers, format json) ${BLOCKING_QUERY}`,
  );
  const top = r.rows[0]!['QUERY PLAN'][0];
  return { label, executionMs: top['Execution Time'], planningMs: top['Planning Time'], plan: toPlanNode(top.Plan), resultRows: top.Plan['Actual Rows'] };
}

export async function runScaleCheck(rowCount = 1_000_000): Promise<ScaleReport> {
  const pg = await PGlite.create();
  try {
    let t0 = performance.now();
    // Cast to bigint before multiplying: int4 overflows on the hash-like spreads below.
    await pg.exec(`
      create table record_scale as
      select g as id,
        (array['Ram','Ford','Toyota','Honda','Hyundai','Chevrolet','Nissan','Jeep'])[1 + (g % 8)::int] as make,
        (array['1500','F-150','RAV4','Civic','Elantra','Silverado','Rogue','Grand Cherokee'])[1 + (g % 8)::int] as model,
        2012 + ((g / 8) % 13)::int as model_year,
        'S' || lpad(((g * 7919) % 5000)::text, 4, '0') as seller,
        ((g * 104729) % 150000)::int as km,
        -- Independent of the seller (g mod 5000), so each lot has VIN-less rows.
        ((g / 5000) % 10) <> 0 as has_vin
      from generate_series(1::bigint, ${Math.trunc(rowCount)}::bigint) g;
      analyze record_scale;
    `);
    const insertMs = performance.now() - t0;
    const withoutIndex = await explain(pg, 'Without index');
    t0 = performance.now();
    await pg.exec('create index record_scale_block on record_scale (seller, make, model, model_year, km); analyze record_scale;');
    const indexMs = performance.now() - t0;
    const withIndex = await explain(pg, 'With composite index');
    return { rows: rowCount, insertMs, indexMs, query: BLOCKING_QUERY, withoutIndex, withIndex };
  } finally {
    await pg.close();
  }
}
