// The platform: wires landing, matching, survivorship, builds, rule replay and quality together.
// HTTP handlers call these methods; each public method takes the database queue once.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  BuildSummary,
  ColumnMapping,
  Decision,
  DriftReport,
  DropSummary,
  FieldName,
  GoldenRecord,
  LinkEvidence,
  MatchedRecord,
  QualityReport,
  RulePreview,
  RuleSet,
  ScaleReport,
  SourceId,
  SourceInfo,
  Summary,
  UnresolvedRecord,
  VehicleDetail,
  VehicleRow,
} from '../shared/types.js';
import { buildRecords, latestBuildId, listBuilds, writeBuild } from './builds.js';
import { Database, one, rows, type Sql } from './db.js';
import { VinPatternDecoder } from './decoder.js';
import { namedErrors, pairMetrics, scoreField, SCORED_FIELDS, truthVehicles, verdict } from './evaluate.js';
import { approveMapping, landAll, refreshRecords, seedMapping, type LandResult } from './ingest.js';
import { CANNOT_LINK_SQL, decodeNewVins, runMatcher, type MatchStats } from './matcher.js';
import { ALIASES, TRIM_WORDS } from './reference.js';
import { CORE_FIELDS, SOURCES, activateRuleSet, activeRuleSet, loadSeedRules, proposeFieldChange } from './rules.js';
import { runScaleCheck } from './scale.js';
import { buildObservations, computeGolden, vehicleTitle } from './survivorship.js';
import { describeRepair, type Repair } from './vin.js';

export interface PlatformPaths {
  /** Repo root: holds data/, rules/ */
  root: string;
  /** Writable state: pg/, landing/, builds/, vpic.lite.db. Omit pgDir for an in-memory database. */
  dataDir: string;
  inMemory?: boolean;
  /** Where the unpacked decoder data lives. Defaults to dataDir. */
  vpicDir?: string;
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export class Platform {
  private constructor(
    readonly db: Database,
    private readonly decoder: VinPatternDecoder,
    private readonly paths: PlatformPaths,
  ) {}

  get landingDir() {
    return join(this.paths.dataDir, 'landing');
  }
  get buildsDir() {
    return join(this.paths.dataDir, 'builds');
  }
  get sourcesDir() {
    return join(this.paths.root, 'data', 'sources');
  }

  static async open(paths: PlatformPaths): Promise<Platform> {
    const db = await Database.open(paths.inMemory ? undefined : join(paths.dataDir, 'pg'));
    const decoder = await VinPatternDecoder.open(paths.vpicDir ?? paths.dataDir);
    const p = new Platform(db, decoder, paths);
    await p.initialise();
    return p;
  }

  async close(): Promise<void> {
    await this.db.close();
    await this.decoder.close();
  }

  /** First start seeds reference data, rules and truth, lands every file and runs build #1. */
  private async initialise(): Promise<void> {
    const fresh = await this.db.exclusive(async (sql) => {
      const r = await one<{ n: number }>(sql, 'select count(*)::int as n from rule_set');
      return (r?.n ?? 0) === 0;
    });
    if (fresh) {
      await this.db.transaction(async (tx) => {
        for (const s of SOURCES) {
          await tx.query('insert into source (id, label, tier, kind, description) values ($1, $2, $3, $4, $5) on conflict (id) do nothing', [s.id, s.label, s.tier, s.kind, s.description]);
        }
        await tx.query(
          `insert into make_alias (alias, make, model) select x.alias, x.make, x.model from jsonb_to_recordset($1::jsonb) as x(alias text, make text, model text) on conflict do nothing`,
          [JSON.stringify(ALIASES)],
        );
        await tx.query(`insert into trim_word (word) select distinct x from jsonb_array_elements_text($1::jsonb) as x on conflict do nothing`, [JSON.stringify(TRIM_WORDS)]);
        const rules = loadSeedRules(join(this.paths.root, 'rules', 'v1.json'));
        await activateRuleSet(tx, rules, 'Seeded from rules/v1.json');
        const mapping = JSON.parse(readFileSync(join(this.paths.root, 'data', 'mappings', 'registration.v1.json'), 'utf8')) as ColumnMapping;
        await seedMapping(tx, mapping);
        const truth = JSON.parse(readFileSync(join(this.paths.root, 'data', 'truth.json'), 'utf8')) as {
          cases: Record<string, string>;
          vehicles: Record<string, Record<string, unknown>>;
          records: Record<string, { vin: string; caseTag: string }>;
        };
        await tx.query(`insert into truth_case (tag, label) select key, value from jsonb_each_text($1::jsonb)`, [JSON.stringify(truth.cases)]);
        await tx.query(`insert into truth_vehicle (vin, attrs) select key, value from jsonb_each($1::jsonb)`, [JSON.stringify(truth.vehicles)]);
        await tx.query(
          `insert into truth_record (record_id, true_vin, case_tag) select key, value->>'vin', value->>'caseTag' from jsonb_each($1::jsonb)`,
          [JSON.stringify(truth.records)],
        );
      });
    }
    await this.land();
    const built = await this.db.exclusive((sql) => latestBuildId(sql));
    if (built === null) await this.rebuild('initial build');
  }

  /** Lands any new source file. Landing a file twice adds nothing. */
  land(): Promise<LandResult> {
    return this.db.transaction((tx) => landAll(tx, this.sourcesDir, this.landingDir));
  }

  /** Staging to records, decode, match, survivorship, then a build with full and delta files. */
  rebuild(trigger = 'rebuild'): Promise<BuildSummary & { match: MatchStats }> {
    return this.db.transaction(async (tx) => {
      const rules = await activeRuleSet(tx);
      await refreshRecords(tx);
      await decodeNewVins(tx, this.decoder);
      const match = await runMatcher(tx, rules.matching.kmBand);
      await buildObservations(tx);
      const golden = await computeGolden(tx);
      const summary = await writeBuild(tx, this.buildsDir, golden, trigger, rules.version);
      await tx.query(`update landing_file set status = 'loaded' where status = 'pending_rebuild'`);
      return { ...summary, match };
    });
  }

  // ---------- sources ----------

  sources(): SourceInfo[] {
    return [...SOURCES];
  }

  drops(): Promise<DropSummary[]> {
    return this.db.exclusive(async (sql) => {
      const r = await rows<{
        id: number; source: SourceId; drop_date: string; key: string; sha256: string; bytes: number; rows: number;
        status: DropSummary['status']; mapping_version: number | null; landed_at: string;
      }>(sql, `select id, source, to_char(drop_date, 'YYYY-MM-DD') as drop_date, key, sha256, bytes, rows, status, mapping_version, landed_at from landing_file order by source, drop_date`);
      return r.map((d) => ({
        id: d.id, source: d.source, dropDate: d.drop_date, key: d.key, sha256: d.sha256, bytes: d.bytes, rows: d.rows,
        status: d.status, mappingVersion: d.mapping_version, landedAt: new Date(d.landed_at).toISOString(),
      }));
    });
  }

  drop(id: number): Promise<{ drop: DropSummary; drift: DriftReport | null; nextMappingVersion: number }> {
    return this.db.exclusive(async (sql) => {
      const all = await rows<{ id: number; drift: DriftReport | null; source: SourceId }>(sql, 'select id, drift, source from landing_file where id = $1', [id]);
      const f = all[0];
      if (!f) throw new NotFoundError('no such drop');
      const v = await one<{ v: number }>(sql, 'select coalesce(max(version), 0)::int + 1 as v from column_mapping where source = $1', [f.source]);
      const d = (await rows<DropSummary & { drop_date: string }>(
        sql,
        `select id, source, to_char(drop_date, 'YYYY-MM-DD') as "dropDate", key, sha256, bytes, rows, status, mapping_version as "mappingVersion", landed_at as "landedAt" from landing_file where id = $1`,
        [id],
      ))[0]!;
      return { drop: { ...d, landedAt: new Date(d.landedAt).toISOString() }, drift: f.drift, nextMappingVersion: v?.v ?? 1 };
    });
  }

  approve(id: number, columns: Record<string, string>, dateFormat: ColumnMapping['dateFormat'], note: string): Promise<ColumnMapping> {
    return this.db.transaction((tx) => approveMapping(tx, this.landingDir, id, columns, dateFormat, note));
  }

  builds(): Promise<BuildSummary[]> {
    return this.db.exclusive((sql) => listBuilds(sql));
  }

  /** Absolute path of a build file, checked against the build table. */
  buildFile(id: number, kind: 'full' | 'delta'): string {
    const p = join(this.buildsDir, String(id).padStart(4, '0'), `${kind}.ndjson`);
    if (!existsSync(p)) throw new NotFoundError('no such build file');
    return p;
  }

  // ---------- vehicles ----------

  private async currentGolden(sql: Sql): Promise<{ buildId: number; golden: Map<string, GoldenRecord> }> {
    const buildId = await latestBuildId(sql);
    if (buildId === null) throw new NotFoundError('no build yet');
    return { buildId, golden: await buildRecords(sql, buildId) };
  }

  vehicles(): Promise<VehicleRow[]> {
    return this.db.exclusive(async (sql) => {
      const { golden } = await this.currentGolden(sql);
      const counts = await rows<{ vin: string; source: SourceId; n: number }>(
        sql,
        `select l.vehicle_vin as vin, r.source, count(*)::int as n from match_link l join source_record r using (record_id) group by 1, 2`,
      );
      const bySource = new Map<string, Partial<Record<SourceId, number>>>();
      for (const c of counts) bySource.set(c.vin, { ...(bySource.get(c.vin) ?? {}), [c.source]: c.n });
      return [...golden.values()]
        .sort((a, b) => a.vin.localeCompare(b.vin))
        .map((g) => {
          const f = g.fields;
          const conflicts = CORE_FIELDS.filter((k) => f[k].conflict);
          const empty = CORE_FIELDS.filter((k) => f[k].value === null);
          const flags = [...new Set(CORE_FIELDS.flatMap((k) => (f[k].flags.some((x) => x.includes('below an earlier')) ? ['odometer rollback'] : [])))];
          return {
            vin: g.vin,
            title: vehicleTitle(g),
            trim: f.trim.value,
            observedTrim: f.observedTrim.value,
            odometerKm: f.odometerKm.value,
            sources: { vin_pattern: f.make.source === 'vin_pattern' ? 1 : 0, ...(bySource.get(g.vin) ?? {}) },
            conflicts,
            empty,
            flags,
          };
        });
    });
  }

  vehicle(vin: string): Promise<VehicleDetail> {
    return this.db.exclusive(async (sql) => {
      const { buildId, golden } = await this.currentGolden(sql);
      const g = golden.get(vin.toUpperCase());
      if (!g) throw new NotFoundError(`no vehicle ${vin}`);
      const recs = await rows<{
        record_id: string; source: SourceId; tier: number; observed_at: string | null; vin_raw: string | null; vin_norm: string | null;
        vin_check_ok: boolean; method: LinkEvidence['method']; evidence: Record<string, unknown>; payload: Record<string, unknown>;
        check_expected: string | null; decoder_summary: string | null; withheld_reason: string | null;
      }>(
        sql,
        `select r.record_id, r.source, r.tier, to_char(r.observed_at, 'YYYY-MM-DD') as observed_at, r.vin_raw, r.vin_norm, r.vin_check_ok,
           l.method, l.evidence, r.payload, d.check_expected, d.decoder_summary, d.withheld_reason
         from match_link l join source_record r using (record_id) left join decoded_vin d on d.vin = r.vin_norm
         where l.vehicle_vin = $1 order by r.tier, r.observed_at, r.record_id`,
        [g.vin],
      );
      const records: MatchedRecord[] = recs.map((r) => ({
        recordId: r.record_id,
        source: r.source,
        tier: r.tier,
        observedAt: r.observed_at,
        vinRaw: r.vin_raw,
        vinCheck: !r.vin_norm ? 'missing' : r.vin_check_ok ? 'pass' : /^[A-HJ-NPR-Z0-9]{17}$/.test(r.vin_norm) ? 'fail' : 'bad_shape',
        checkExpected: r.check_expected,
        withheldDecode: r.vin_check_ok ? null : r.decoder_summary ? `${r.withheld_reason ?? 'withheld'}. The decoder still returned ${r.decoder_summary}.` : r.withheld_reason,
        link: linkEvidence(r.method, r.evidence),
        payload: r.payload,
      }));
      return { golden: g, records, buildId };
    });
  }

  unresolved(): Promise<UnresolvedRecord[]> {
    return this.db.exclusive(async (sql) => {
      const r = await rows<{ record_id: string; source: SourceId; vin_raw: string | null; summary: string; reason: string | null; candidates: string[] }>(
        sql,
        `select r.record_id, r.source, r.vin_raw,
           concat_ws(' · ', coalesce(r.title, nullif(concat_ws(' ', r.model_year, r.make_raw, r.model_raw), '')), r.seller,
             case when r.km is not null then to_char(r.km, 'FM999,999') || ' km' end) as summary,
           u.reason, coalesce(u.candidates, '[]'::jsonb) as candidates
         from source_record r left join match_unresolved u using (record_id)
         where not exists (select 1 from match_link l where l.record_id = r.record_id)
         order by r.record_id`,
      );
      return r.map((x) => ({ recordId: x.record_id, source: x.source, vinRaw: x.vin_raw, summary: x.summary, reason: x.reason ?? 'not linked', candidates: x.candidates }));
    });
  }

  summary(): Promise<Summary> {
    return this.db.exclusive(async (sql) => {
      const s = await one<Summary>(
        sql,
        `select (select max(id) from build) as "buildId",
           (select version from rule_set where active) as "ruleSetVersion",
           (select vehicles from build order by id desc limit 1)::int as vehicles,
           (select count(*)::int from source_record) as records,
           (select count(*)::int from source_record r where not exists (select 1 from match_link l where l.record_id = r.record_id)) as unresolved,
           (select count(*)::int from landing_file where status = 'quarantined') as quarantined,
           (select count(*)::int from landing_file where status = 'pending_rebuild') as "pendingRebuild"`,
      );
      return { ...s!, vehicles: s!.vehicles ?? 0 };
    });
  }

  // ---------- rules ----------

  rules(): Promise<{ rules: RuleSet; decisions: Decision[] }> {
    return this.db.exclusive(async (sql) => ({ rules: await activeRuleSet(sql), decisions: await listDecisions(sql) }));
  }

  /** Replays a proposed rule inside a transaction that always rolls back. Nothing is written. */
  preview(field: FieldName, sources: SourceId[]): Promise<RulePreview> {
    return this.db.exclusive((sql) => previewIn(this.db, sql, field, sources));
  }

  /** Records an Accept or Reject with its reason. Accept activates the rule and runs a build. */
  decide(field: FieldName, sources: SourceId[], decision: 'accepted' | 'rejected', reason: string): Promise<{ decision: Decision; build: BuildSummary | null }> {
    if (!reason.trim()) return Promise.reject(new ValidationError('a decision needs a reason'));
    return this.db.exclusive(async (sql) => {
      const p = await previewIn(this.db, sql, field, sources);
      if (JSON.stringify(p.from.sources) === JSON.stringify(p.to.sources)) throw new ValidationError('the proposal does not change the rule');
      return this.db.pg.transaction(async (tx) => {
        const current = await activeRuleSet(tx);
        const next = proposeFieldChange(current, field, sources);
        let build: BuildSummary | null = null;
        if (decision === 'accepted') {
          await activateRuleSet(tx, next, reason.trim());
          const golden = await computeGolden(tx);
          build = await writeBuild(tx, this.buildsDir, golden, `rule accepted: ${next.fields[field].id} v${next.fields[field].version}`, next.version);
        }
        const d = await one<{ id: number }>(
          tx,
          `insert into decision (field, decision, rule_id, proposed_rule_id, from_version, proposed_version, proposed_sources, reason, score_before, score_after, build_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [field, decision, current.fields[field].id, next.fields[field].id, current.fields[field].version, next.fields[field].version, JSON.stringify(sources), reason.trim(), JSON.stringify(p.before), JSON.stringify(p.after), build?.id ?? null],
        );
        const all = await listDecisions(tx);
        return { decision: all.find((x) => x.id === d!.id)!, build };
      });
    });
  }

  // ---------- quality ----------

  quality(): Promise<QualityReport> {
    return this.db.exclusive(async (sql) => {
      const { buildId, golden } = await this.currentGolden(sql);
      const truth = await truthVehicles(sql);
      const list = [...golden.values()];
      const violations = await one<{ n: number }>(sql, `select (${CANNOT_LINK_SQL}) as n`);
      return {
        pairs: await pairMetrics(sql),
        errors: await namedErrors(sql),
        cannotLinkViolations: violations?.n ?? 0,
        fieldAccuracy: SCORED_FIELDS.map((f) => ({ field: f, score: scoreField(f, list, truth) })),
        buildId,
        note: 'Measured on our own synthetic set against its synthetic truth labels. This is not real-world accuracy.',
      };
    });
  }

  /** Runs the scale check in a worker thread when compiled, inline under the test runner. */
  scaleCheck(rowCount = 1_000_000): Promise<ScaleReport> {
    // One scale run at a time: a second click joins the run in progress.
    this.scaleRun ??= this.startScaleCheck(rowCount).finally(() => {
      this.scaleRun = null;
    });
    return this.scaleRun;
  }

  private scaleRun: Promise<ScaleReport> | null = null;

  private startScaleCheck(rowCount: number): Promise<ScaleReport> {
    const workerUrl = new URL('./scale-worker.js', import.meta.url);
    if (!import.meta.url.endsWith('.js') || !existsSync(workerUrl)) return runScaleCheck(rowCount);
    return new Promise((resolve, reject) => {
      const w = new Worker(workerUrl, { workerData: { rows: rowCount } });
      w.once('message', (m: { ok: true; report: ScaleReport } | { ok: false; error: string }) => {
        if (m.ok) resolve(m.report);
        else reject(new Error(m.error));
        void w.terminate();
      });
      w.once('error', reject);
    });
  }

  /** Deletes all writable state. Used by npm run reset. */
  static reset(dataDir: string): void {
    for (const d of ['pg', 'landing', 'builds']) rmSync(join(dataDir, d), { recursive: true, force: true });
  }
}

function linkEvidence(method: LinkEvidence['method'], ev: Record<string, unknown>): LinkEvidence {
  if (method === 'repair') {
    const r = ev['repair'] as Repair;
    return { method, detail: describeRepair(r), repair: { kind: r.kind, positions: r.positions, from: r.from, to: r.to } };
  }
  if (method === 'attribute') {
    const b = ev['blocking'] as NonNullable<LinkEvidence['blocking']>;
    return {
      method,
      detail: `no VIN; the only vehicle on ${b.seller} that fits ${b.modelYear} ${b.make} ${b.model} within ${b.kmBand.toLocaleString('en-US')} km (${b.candidateKm.toLocaleString('en-US')} km on record, listing says ${b.km.toLocaleString('en-US')} km)`,
      blocking: b,
    };
  }
  return { method, detail: String(ev['detail'] ?? 'exact VIN match') };
}

async function listDecisions(sql: Sql): Promise<Decision[]> {
  const r = await rows<{
    id: number; at: string; field: FieldName; decision: Decision['decision']; rule_id: string; proposed_rule_id: string; from_version: number; proposed_version: number;
    proposed_sources: SourceId[]; reason: string; score_before: Decision['before']; score_after: Decision['after']; build_id: number | null;
  }>(sql, 'select * from decision order by id desc');
  return r.map((d) => ({
    id: d.id, at: new Date(d.at).toISOString(), field: d.field, decision: d.decision, ruleId: d.rule_id, proposedRuleId: d.proposed_rule_id, fromVersion: d.from_version,
    proposedVersion: d.proposed_version, proposedSources: d.proposed_sources, reason: d.reason, before: d.score_before, after: d.score_after, buildId: d.build_id,
  }));
}

/** Replay: switch the rule inside a transaction, recompute golden values, score them, roll back. */
async function previewIn(db: Database, _sql: Sql, field: FieldName, sources: SourceId[]): Promise<RulePreview> {
  let result: RulePreview | null = null;
  await db.pg.transaction(async (tx) => {
    const truth = await truthVehicles(tx);
    const current = await activeRuleSet(tx);
    const next = proposeFieldChange(current, field, sources);
    const before = await computeGolden(tx);
    await activateRuleSet(tx, next, 'replay (rolled back)');
    const after = await computeGolden(tx);
    const afterBy = new Map(after.map((g) => [g.vin, g]));
    const changes = before.flatMap((b) => {
      const a = afterBy.get(b.vin);
      if (!a || a.fields[field].value === b.fields[field].value) return [];
      const t = truth.get(b.vin)?.[field] ?? null;
      return [{
        vin: b.vin,
        title: vehicleTitle(b),
        before: b.fields[field].value,
        after: a.fields[field].value,
        afterSource: a.fields[field].source,
        truth: t,
        verdict: verdict(field, a.fields[field].value, t),
      }];
    });
    result = {
      field,
      from: current.fields[field],
      to: next.fields[field],
      changes,
      before: scoreField(field, before, truth),
      after: scoreField(field, after, truth),
      wrongAfter: changes.filter((c) => c.verdict === 'wrong'),
      rolledBack: true,
    };
    await tx.rollback();
  });
  if (!result) throw new Error('replay produced no result');
  return result;
}
