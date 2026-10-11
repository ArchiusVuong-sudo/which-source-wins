// Scoring against the synthetic truth labels: field accuracy (correct, wrong, empty) and
// pairwise precision, recall and F1 for the matcher, with every error named by its planted case.

import type { FieldName, FieldValue, GoldenRecord, NamedError, PairMetrics, Score, SourceId } from '../shared/types.js';
import { rows, type Sql } from './db.js';
import { modelKey } from './reference.js';

export type TruthAttrs = Partial<Record<FieldName, string | number | null>>;

export async function truthVehicles(sql: Sql): Promise<Map<string, TruthAttrs>> {
  const r = await rows<{ vin: string; attrs: TruthAttrs }>(sql, 'select vin, attrs from truth_vehicle');
  return new Map(r.map((x) => [x.vin, x.attrs]));
}

const norm = (field: FieldName, v: FieldValue | undefined): string | null => {
  if (v === null || v === undefined) return null;
  return field === 'model' ? modelKey(String(v)) : String(v).trim().toLowerCase();
};

export type Verdict = 'correct' | 'wrong' | 'empty';

/** Empty beats wrong: a null where the truth has a value is "empty", never "wrong". */
export function verdict(field: FieldName, value: FieldValue, truth: FieldValue | undefined): Verdict {
  const v = norm(field, value);
  const t = norm(field, truth);
  if (v === null) return t === null ? 'correct' : 'empty';
  if (t === null) return 'wrong';
  return v === t ? 'correct' : 'wrong';
}

export function scoreField(field: FieldName, golden: GoldenRecord[], truth: Map<string, TruthAttrs>): Score {
  const s: Score = { correct: 0, wrong: 0, empty: 0, total: 0 };
  for (const g of golden) {
    const t = truth.get(g.vin);
    if (!t) continue;
    s[verdict(field, g.fields[field].value, t[field] ?? null)]++;
    s.total++;
  }
  return s;
}

export const SCORED_FIELDS: readonly FieldName[] = ['make', 'model', 'modelYear', 'trim', 'colour', 'registeredProvince'];

// ---------- matching ----------

const PAIRS_SQL = `
  with j as (
    select r.record_id, coalesce(l.vehicle_vin, 'unresolved:' || r.record_id) as cluster, t.true_vin
    from source_record r
    join truth_record t using (record_id)
    left join match_link l using (record_id)
  )
  select a.record_id as a, b.record_id as b, a.cluster = b.cluster as same_pred, a.true_vin = b.true_vin as same_true
  from j a join j b on a.record_id < b.record_id
  where a.cluster = b.cluster or a.true_vin = b.true_vin
`;

export async function pairMetrics(sql: Sql): Promise<PairMetrics> {
  const [m] = await rows<{ records: number; tp: number; fp: number; fn: number }>(
    sql,
    `with p as (${PAIRS_SQL})
     select (select count(*)::int from source_record r join truth_record t using (record_id)) as records,
       count(*) filter (where same_pred and same_true)::int as tp,
       count(*) filter (where same_pred and not same_true)::int as fp,
       count(*) filter (where not same_pred and same_true)::int as fn
     from p`,
  );
  const { records, tp, fp, fn } = m!;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { records, truePairs: tp + fn, predictedPairs: tp + fp, tp, fp, fn, precision, recall, f1 };
}

interface RecordRow {
  record_id: string;
  source: SourceId;
  vin_raw: string | null;
  summary: string;
  true_vin: string;
  predicted_vin: string | null;
  case_tag: string;
  case_label: string;
  method: string | null;
  unresolved_reason: string | null;
}

const RECORDS_SQL = `
  select r.record_id, r.source, r.vin_raw,
    concat_ws(' · ', coalesce(r.title, nullif(concat_ws(' ', r.model_year, r.make_raw, r.model_raw), '')), r.seller,
      case when r.km is not null then to_char(r.km, 'FM999,999') || ' km' end, r.colour) as summary,
    t.true_vin, l.vehicle_vin as predicted_vin, t.case_tag, coalesce(c.label, t.case_tag) as case_label,
    l.method, u.reason as unresolved_reason
  from source_record r
  join truth_record t using (record_id)
  left join truth_case c on c.tag = t.case_tag
  left join match_link l using (record_id)
  left join match_unresolved u using (record_id)
`;

/** Every record the matcher placed wrongly, grouped by planted case, with the records behind it. */
export async function namedErrors(sql: Sql): Promise<NamedError[]> {
  const all = await rows<RecordRow>(sql, RECORDS_SQL + ' order by r.record_id');
  const pairs = await rows<{ a: string; b: string; same_pred: boolean; same_true: boolean }>(sql, PAIRS_SQL);
  const byTrue = new Map<string, RecordRow[]>();
  const byPred = new Map<string, RecordRow[]>();
  for (const r of all) {
    byTrue.set(r.true_vin, [...(byTrue.get(r.true_vin) ?? []), r]);
    if (r.predicted_vin) byPred.set(r.predicted_vin, [...(byPred.get(r.predicted_vin) ?? []), r]);
  }
  const touching = (id: string, fp: boolean) => pairs.filter((p) => (p.a === id || p.b === id) && (fp ? p.same_pred && !p.same_true : !p.same_pred && p.same_true)).length;
  const toOut = (r: RecordRow) => ({ recordId: r.record_id, source: r.source, vinRaw: r.vin_raw, summary: r.summary, trueVin: r.true_vin, predictedVin: r.predicted_vin });

  const errors: NamedError[] = [];
  for (const r of all) {
    if (r.predicted_vin && r.predicted_vin !== r.true_vin) {
      const others = (byPred.get(r.predicted_vin) ?? []).filter((x) => x.record_id !== r.record_id);
      errors.push({
        kind: 'false_merge',
        caseTag: r.case_tag,
        caseLabel: r.case_label,
        pairs: touching(r.record_id, true),
        explanation: `${r.record_id} was linked to ${r.predicted_vin} by ${r.method === 'exact' ? 'an exact VIN match with a passing check digit' : r.method}, but the truth places it on ${r.true_vin}.`,
        records: [toOut(r), ...others.map(toOut)],
      });
    } else if (!r.predicted_vin && (byTrue.get(r.true_vin)?.length ?? 0) > 1) {
      const others = (byTrue.get(r.true_vin) ?? []).filter((x) => x.record_id !== r.record_id);
      errors.push({
        kind: 'missed_match',
        caseTag: r.case_tag,
        caseLabel: r.case_label,
        pairs: touching(r.record_id, false),
        explanation: `${r.record_id} is unmatched: ${r.unresolved_reason ?? 'no link'}. The truth places it on ${r.true_vin}.`,
        records: [toOut(r), ...others.map(toOut)],
      });
    }
  }
  return errors;
}
