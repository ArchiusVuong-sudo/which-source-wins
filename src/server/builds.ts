// Builds: every build writes the full golden set and a delta against the previous build as
// NDJSON, each with its row count and SHA-256. Keys follow builds/<id>/{full,delta}.ndjson.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildSummary, GoldenRecord } from '../shared/types.js';
import { one, rows, type Sql } from './db.js';
import { sha256 } from './ingest.js';

export interface DeltaLine {
  op: 'added' | 'changed' | 'removed';
  vin: string;
  record?: GoldenRecord;
}

export function toNdjson(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}

/** Pure diff of two builds keyed by VIN. `prev` maps VIN to the record hash of the earlier build. */
export function diffBuild(prev: Map<string, string>, next: GoldenRecord[]): { delta: DeltaLine[]; added: number; changed: number; removed: number } {
  const delta: DeltaLine[] = [];
  let added = 0;
  let changed = 0;
  const seen = new Set<string>();
  for (const g of next) {
    seen.add(g.vin);
    const h = sha256(JSON.stringify(g));
    const before = prev.get(g.vin);
    if (before === undefined) {
      added++;
      delta.push({ op: 'added', vin: g.vin, record: g });
    } else if (before !== h) {
      changed++;
      delta.push({ op: 'changed', vin: g.vin, record: g });
    }
  }
  let removed = 0;
  for (const vin of [...prev.keys()].sort()) {
    if (!seen.has(vin)) {
      removed++;
      delta.push({ op: 'removed', vin });
    }
  }
  return { delta, added, changed, removed };
}

export async function latestBuildId(sql: Sql): Promise<number | null> {
  const r = await one<{ id: number }>(sql, 'select max(id) as id from build');
  return r?.id ?? null;
}

export async function writeBuild(sql: Sql, buildsDir: string, golden: GoldenRecord[], trigger: string, ruleSetVersion: number): Promise<BuildSummary> {
  const prevId = await latestBuildId(sql);
  const prev = new Map(
    prevId === null ? [] : (await rows<{ vin: string; sha256: string }>(sql, 'select vin, sha256 from build_vehicle where build_id = $1', [prevId])).map((r) => [r.vin, r.sha256] as const),
  );
  const sorted = [...golden].sort((a, b) => a.vin.localeCompare(b.vin));
  const { delta, added, changed, removed } = diffBuild(prev, sorted);
  const idRow = await one<{ id: number }>(sql, `select nextval(pg_get_serial_sequence('build', 'id'))::int as id`);
  const id = idRow!.id;
  const dir = `builds/${String(id).padStart(4, '0')}`;
  const full = toNdjson(sorted);
  const deltaText = toNdjson(delta);
  mkdirSync(join(buildsDir, String(id).padStart(4, '0')), { recursive: true });
  writeFileSync(join(buildsDir, String(id).padStart(4, '0'), 'full.ndjson'), full);
  writeFileSync(join(buildsDir, String(id).padStart(4, '0'), 'delta.ndjson'), deltaText);
  const summary: BuildSummary = {
    id,
    createdAt: new Date().toISOString(),
    trigger,
    ruleSetVersion,
    vehicles: sorted.length,
    added,
    changed,
    removed,
    full: { key: `${dir}/full.ndjson`, rows: sorted.length, sha256: sha256(full) },
    delta: { key: `${dir}/delta.ndjson`, rows: delta.length, sha256: sha256(deltaText) },
  };
  await sql.query(
    `insert into build (id, trigger, rule_set_version, vehicles, added, changed, removed, full_key, full_rows, full_sha256, delta_key, delta_rows, delta_sha256)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, trigger, ruleSetVersion, summary.vehicles, added, changed, removed, summary.full.key, summary.full.rows, summary.full.sha256, summary.delta.key, summary.delta.rows, summary.delta.sha256],
  );
  await sql.query(
    `insert into build_vehicle (build_id, vin, sha256, record)
     select $1, x.vin, x.sha256, x.record from json_to_recordset($2::json) as x(vin text, sha256 text, record json)`,
    [id, JSON.stringify(sorted.map((g) => ({ vin: g.vin, sha256: sha256(JSON.stringify(g)), record: g })))],
  );
  return summary;
}

export async function listBuilds(sql: Sql): Promise<BuildSummary[]> {
  const r = await rows<{
    id: number; created_at: string; trigger: string; rule_set_version: number; vehicles: number; added: number; changed: number; removed: number;
    full_key: string; full_rows: number; full_sha256: string; delta_key: string; delta_rows: number; delta_sha256: string;
  }>(sql, 'select * from build order by id desc');
  return r.map((b) => ({
    id: b.id,
    createdAt: new Date(b.created_at).toISOString(),
    trigger: b.trigger,
    ruleSetVersion: b.rule_set_version,
    vehicles: b.vehicles,
    added: b.added,
    changed: b.changed,
    removed: b.removed,
    full: { key: b.full_key, rows: b.full_rows, sha256: b.full_sha256 },
    delta: { key: b.delta_key, rows: b.delta_rows, sha256: b.delta_sha256 },
  }));
}

/** Golden records of a build, keyed by VIN. */
export async function buildRecords(sql: Sql, buildId: number): Promise<Map<string, GoldenRecord>> {
  const r = await rows<{ vin: string; record: GoldenRecord }>(sql, 'select vin, record from build_vehicle where build_id = $1', [buildId]);
  return new Map(r.map((x) => [x.vin, x.record]));
}
