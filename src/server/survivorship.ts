// Survivorship: every golden field is picked in SQL by the active rule set.
//   precedence:      DISTINCT ON (vin, field) ordered by the rule's source order, then newest as-of date.
//   latest_reading:  newest reading first; a reading below an earlier one (window function) cannot win.
// The result for each field is {value, source, tier, asOf, ruleId, ruleVersion, alsoReported, conflict, reason}.

import {
  FIELD_NAMES,
  type AlsoReported,
  type FieldName,
  type FieldValue,
  type GoldenField,
  type GoldenRecord,
  type PatternEvidence,
  type RuleSet,
  type SourceId,
} from '../shared/types.js';
import { rows, type Sql } from './db.js';
import { FIELD_LABELS, SOURCE_BY_ID, activeRuleSet, sourcesLabel } from './rules.js';

const NUMERIC_FIELDS: ReadonlySet<FieldName> = new Set<FieldName>(['modelYear', 'odometerKm']);

/** Rebuilds the observation table: pattern facts per vehicle VIN plus one row per record and field. */
export async function buildObservations(sql: Sql): Promise<void> {
  await sql.exec(`
    delete from observation;

    insert into observation (vin, field, value, value_num, norm, raw, source, tier, as_of, record_id, evidence)
    select v.vin, f->>'field', f->>'value',
      case when f->>'field' = 'modelYear' then (f->>'value')::numeric end,
      case when f->>'field' = 'model' then model_key(f->>'value') else lower(f->>'value') end,
      f->>'value', 'vin_pattern', s.tier, null, null, f->'evidence'
    from vehicle v
    join decoded_vin d on d.vin = v.vin and d.check_ok
    cross join jsonb_array_elements(d.facts) f
    join source s on s.id = 'vin_pattern';

    insert into observation (vin, field, value, value_num, norm, raw, source, tier, as_of, record_id)
    select l.vehicle_vin, x.field, x.value, x.value_num, x.norm, x.raw, r.source, r.tier, r.observed_at, r.record_id
    from match_link l
    join source_record r using (record_id)
    cross join lateral (values
      ('make', r.make, null::numeric, lower(r.make), r.make_raw),
      ('model', r.model, null, model_key(r.model), r.model_raw),
      ('modelYear', r.model_year::text, r.model_year::numeric, r.model_year::text, r.model_year::text),
      ('colour', r.colour, null, lower(r.colour), r.colour),
      ('odometerKm', r.km::text, r.km::numeric, r.km::text, r.km::text),
      ('registeredProvince', r.province, null, lower(r.province), r.province),
      ('registrationDate', to_char(r.registration_date, 'YYYY-MM-DD'), null, to_char(r.registration_date, 'YYYY-MM-DD'), null),
      ('observedTrim', r.observed_trim, null, lower(r.observed_trim), r.observed_trim),
      ('trim', r.observed_trim, null, lower(r.observed_trim), r.observed_trim)
    ) as x(field, value, value_num, norm, raw)
    where x.value is not null;

    -- Registry rows carry the registry's observed date: the odometer date for odometer, the drop for the rest.
    update observation o set as_of = (r.payload->>'drop')::date
    from source_record r
    where o.record_id = r.record_id and r.source = 'registration' and o.field <> 'odometerKm';

    -- Odometer rollback: a reading below the highest earlier reading of the same vehicle.
    with w as (
      select record_id, vin, value_num, as_of,
        max(value_num) over (partition by vin order by as_of, value_num rows between unbounded preceding and 1 preceding) as prior_max
      from observation where field = 'odometerKm'
    )
    update observation o set rollback_of = jsonb_build_object('km', p.value_num, 'asOf', p.as_of, 'source', p.source, 'recordId', p.record_id)
    from w
    cross join lateral (
      select * from observation p
      where p.field = 'odometerKm' and p.vin = w.vin and p.value_num = w.prior_max and p.as_of <= w.as_of
      order by p.as_of desc limit 1
    ) p
    where o.field = 'odometerKm' and o.record_id = w.record_id and w.value_num < w.prior_max;
  `);
}

interface ObsRow {
  vin: string;
  field: FieldName;
  value: string | null;
  value_num: string | null;
  norm: string | null;
  raw: string | null;
  source: SourceId;
  tier: number;
  as_of: string | null;
  record_id: string | null;
  evidence: (PatternEvidence & { options: string[] | null }) | null;
  rollback_of: { km: number; asOf: string; source: SourceId; recordId: string } | null;
}

interface WinnerRow {
  vin: string;
  field: FieldName;
  record_id: string | null;
  source: SourceId;
}

/** The SQL winner per (vehicle, field) under the active rule set. */
export const WINNERS_SQL = `
  with rs as (select rules from rule_set where active),
  fr as (
    select f.key as field, f.value as rule,
      array(select jsonb_array_elements_text(f.value->'sources')) as srcs
    from rs, jsonb_each(rs.rules->'fields') f
  ),
  eligible as (
    select o.*, fr.rule->>'kind' as kind, array_position(fr.srcs, o.source) as rank
    from observation o join fr using (field)
    where o.value is not null and array_position(fr.srcs, o.source) is not null and o.rollback_of is null
      and ($1::text[] is null or o.vin = any($1::text[]))
  )
  select distinct on (vin, field) vin, field, record_id, source
  from eligible
  order by vin, field,
    case when kind = 'latest_reading' then 0 else rank end,
    as_of desc nulls last,
    rank,
    record_id
`;

const fmtValue = (field: FieldName, o: ObsRow): FieldValue => {
  if (o.value === null) return null;
  if (NUMERIC_FIELDS.has(field)) return Number(o.value_num ?? o.value);
  return o.value;
};

const READING_NOUN: Readonly<Record<SourceId, string>> = {
  vin_pattern: 'Pattern value',
  registration: 'Registry reading',
  module_read: 'Module read',
  listing: 'Listing claim',
};
const says = (s: SourceId) => (SOURCE_BY_ID[s].label.endsWith('s') ? 'say' : 'says');
const km = (n: number) => `${n.toLocaleString('en-US')} km`;

export function assembleField(field: FieldName, rules: RuleSet, obs: ObsRow[], winner: WinnerRow | null): GoldenField {
  const rule = rules.fields[field];
  const inRule = obs.filter((o) => rule.sources.includes(o.source));
  const win = winner ? inRule.find((o) => o.source === winner.source && o.record_id === winner.record_id) ?? null : null;
  const patternObs = obs.find((o) => o.source === 'vin_pattern') ?? null;

  const alsoReported: AlsoReported[] = inRule
    .filter((o) => o !== win && o.value !== null)
    .map((o) => ({
      value: NUMERIC_FIELDS.has(field) ? Number(o.value_num ?? o.value) : (o.raw ?? o.value)!,
      source: o.source,
      tier: o.tier,
      asOf: o.as_of,
      recordId: o.record_id,
      // Readings over time are not disagreements; only a rollback is.
      agrees: rule.kind === 'latest_reading' ? !o.rollback_of : win ? o.norm === win.norm : false,
      flag: o.rollback_of
        ? `below an earlier reading: ${km(o.rollback_of.km)} (${SOURCE_BY_ID[o.rollback_of.source].label}, ${o.rollback_of.asOf})`
        : null,
    }))
    .sort((a, b) => a.tier - b.tier || (b.asOf ?? '').localeCompare(a.asOf ?? ''));

  const flags: string[] = [];
  for (const o of inRule) {
    if (o.rollback_of) {
      flags.push(
        `${READING_NOUN[o.source]} of ${km(Number(o.value_num))} (${o.as_of}) is below an earlier reading of ${km(o.rollback_of.km)} (${SOURCE_BY_ID[o.rollback_of.source].label}, ${o.rollback_of.asOf})`,
      );
    }
  }
  const disagreeing = win ? alsoReported.filter((a) => !a.agrees && !a.flag) : [];
  if (rule.kind === 'precedence' && disagreeing.length) {
    const others = [...new Set(disagreeing.map((d) => `${SOURCE_BY_ID[d.source].label} ${says(d.source)} ${d.value}`))];
    flags.push(`Disagrees: ${others.join('; ')}`);
  }
  const conflict = flags.length > 0;

  let reason: string;
  if (win) {
    reason =
      rule.kind === 'latest_reading'
        ? `Newest reading that is not below an earlier one (${win.as_of}).`
        : rule.sources.length === 1
          ? `Only ${SOURCE_BY_ID[win.source].label} may set this field.`
          : `${SOURCE_BY_ID[win.source].label} is the highest-ranked source with a value.`;
  } else if (patternObs?.evidence?.options && rule.sources.includes('vin_pattern')) {
    const fallback = rule.sources.filter((s) => s !== 'vin_pattern');
    reason =
      `VIN pattern lists alternatives (${patternObs.evidence.options.join(', ')}). A shortlist is not a value.` +
      (fallback.length ? ` No value from ${sourcesLabel(fallback)} either.` : '');
  } else if (rule.sources.length === 1 && rule.sources[0] === 'vin_pattern') {
    reason = `The VIN pattern has no ${FIELD_LABELS[field].toLowerCase()} for this VIN. Checked: ${sourcesLabel(rule.sources)}.`;
  } else {
    reason = `No source has a value. Checked: ${sourcesLabel(rule.sources)}.`;
  }

  const pattern = win?.source === 'vin_pattern' ? win.evidence : patternObs?.evidence?.options ? patternObs.evidence : null;
  return {
    value: win ? fmtValue(field, win) : null,
    source: win?.source ?? null,
    tier: win?.tier ?? null,
    asOf: win?.as_of ?? null,
    ruleId: rule.id,
    ruleVersion: rule.version,
    alsoReported,
    conflict,
    reason,
    flags,
    recordId: win?.record_id ?? null,
    pattern: pattern ?? null,
  };
}

/** Golden records for every vehicle (or the given VINs) under the active rule set. */
export async function computeGolden(sql: Sql, vins?: string[]): Promise<GoldenRecord[]> {
  const rules = await activeRuleSet(sql);
  const filter = vins ?? null;
  // One connection: run the three reads in sequence.
  const obs = await rows<ObsRow>(
    sql,
    `select vin, field, value, value_num::text, norm, raw, source, tier, to_char(as_of, 'YYYY-MM-DD') as as_of, record_id, evidence, rollback_of
     from observation where $1::text[] is null or vin = any($1::text[]) order by vin, field, tier, as_of desc nulls last, record_id`,
    [filter],
  );
  const winners = await rows<WinnerRow>(sql, WINNERS_SQL, [filter]);
  const vehicles = await rows<{ vin: string; record_ids: string[] }>(
    sql,
    'select vin, record_ids from vehicle where $1::text[] is null or vin = any($1::text[]) order by vin',
    [filter],
  );
  const obsBy = new Map<string, ObsRow[]>();
  for (const o of obs) {
    const k = `${o.vin}|${o.field}`;
    const list = obsBy.get(k);
    if (list) list.push(o);
    else obsBy.set(k, [o]);
  }
  const winBy = new Map(winners.map((w) => [`${w.vin}|${w.field}`, w]));
  return vehicles.map((v) => {
    const fields = Object.fromEntries(
      FIELD_NAMES.map((f) => [f, assembleField(f, rules, obsBy.get(`${v.vin}|${f}`) ?? [], winBy.get(`${v.vin}|${f}`) ?? null)]),
    ) as Record<FieldName, GoldenField>;
    return { vin: v.vin, synthetic: true, fields, sourceRecords: v.record_ids };
  });
}

export function vehicleTitle(g: GoldenRecord): string {
  const f = g.fields;
  return [f.modelYear.value, f.make.value, f.model.value].filter((x) => x !== null).join(' ');
}

export { FIELD_LABELS };
