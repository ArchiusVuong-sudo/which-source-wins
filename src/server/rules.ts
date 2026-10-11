// Survivorship rules: a versioned rule set, validated with zod, seeded from rules/v1.json.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FIELD_NAMES, SOURCE_IDS, type FieldName, type RuleSet, type SourceId, type SourceInfo } from '../shared/types.js';
import { one, type Sql } from './db.js';

export const SOURCES: readonly SourceInfo[] = [
  { id: 'vin_pattern', label: 'VIN pattern decode (offline vPIC)', tier: 1, kind: 'derived', description: 'Manufacturer VIN patterns from the bundled NHTSA vPIC data, decoded offline. Real reference data.' },
  { id: 'registration', label: 'Registration file', tier: 1, kind: 'observed', description: 'Monthly government registration drops as CSV. Synthetic.' },
  { id: 'module_read', label: 'Vehicle module reads', tier: 2, kind: 'observed', description: 'VIN and odometer captured over the diagnostic port (OBD-II). Synthetic.' },
  { id: 'listing', label: 'Dealer listings', tier: 3, kind: 'observed', description: 'Dealer listing feed as JSON with free-text titles. Synthetic.' },
];

export const SOURCE_BY_ID: Readonly<Record<SourceId, SourceInfo>> = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SourceId, SourceInfo>;

export const FIELD_LABELS: Readonly<Record<FieldName, string>> = {
  make: 'Make',
  model: 'Model',
  modelYear: 'Model year',
  trim: 'Trim',
  series: 'Series',
  body: 'Body',
  drive: 'Drive',
  engine: 'Engine',
  fuel: 'Fuel',
  plant: 'Assembly plant',
  colour: 'Colour',
  odometerKm: 'Odometer',
  registeredProvince: 'Registered province',
  registrationDate: 'Registration date',
  observedTrim: 'Observed trim (seller text)',
};

/** Fields whose null means a data gap worth filtering on (observedTrim is optional by nature). */
export const CORE_FIELDS: readonly FieldName[] = FIELD_NAMES.filter((f) => f !== 'observedTrim');

const sourceId = z.enum(SOURCE_IDS);

export const fieldRuleSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    kind: z.enum(['precedence', 'latest_reading']),
    sources: z.array(sourceId).min(1),
    allowedSources: z.array(sourceId).min(1),
    note: z.string(),
  })
  .refine((r) => new Set(r.sources).size === r.sources.length, { message: 'a source is listed twice' })
  .refine((r) => r.sources.every((s) => r.allowedSources.includes(s)), { message: 'a source is not allowed for this field' });

export const ruleSetSchema = z.object({
  version: z.number().int().positive(),
  matching: z.object({ kmBand: z.number().int().positive() }),
  fields: z.object(Object.fromEntries(FIELD_NAMES.map((f) => [f, fieldRuleSchema])) as Record<FieldName, typeof fieldRuleSchema>),
});

export function parseRuleSet(input: unknown): RuleSet {
  return ruleSetSchema.parse(input) as RuleSet;
}

export function loadSeedRules(path: string): RuleSet {
  return parseRuleSet(JSON.parse(readFileSync(path, 'utf8')));
}

export async function activeRuleSet(sql: Sql): Promise<RuleSet> {
  const r = await one<{ rules: unknown }>(sql, 'select rules from rule_set where active order by version desc limit 1');
  if (!r) throw new Error('no active rule set');
  return parseRuleSet(r.rules);
}

/** Makes `next` the only active rule set. Used for real changes and inside rolled-back replays. */
export async function activateRuleSet(sql: Sql, next: RuleSet, reason: string): Promise<void> {
  await sql.query('update rule_set set active = false where active');
  await sql.query('insert into rule_set (version, rules, active, reason) values ($1, $2, true, $3)', [next.version, JSON.stringify(next), reason]);
}

const SHORT: Readonly<Record<SourceId, string>> = { vin_pattern: 'pattern', registration: 'registry', module_read: 'module', listing: 'seller' };

/** A readable id for a source order, e.g. trim.pattern-then-seller. */
export function deriveRuleId(field: FieldName, kind: 'precedence' | 'latest_reading', sources: readonly SourceId[]): string {
  const prefix = field === 'odometerKm' ? 'odometer' : field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return kind === 'latest_reading' ? `${prefix}.latest-of-${sources.map((s) => SHORT[s]).join('-')}` : `${prefix}.${sources.map((s) => SHORT[s]).join('-then-')}`;
}

/** The rule set that results from giving `field` a new source order. */
export function proposeFieldChange(current: RuleSet, field: FieldName, sources: SourceId[]): RuleSet {
  const rule = current.fields[field];
  const next: RuleSet = {
    ...current,
    version: current.version + 1,
    fields: {
      ...current.fields,
      [field]: {
        ...rule,
        id: deriveRuleId(field, rule.kind, sources),
        version: rule.version + 1,
        sources,
        note: `Source order: ${sourcesLabel(sources)}.`,
      },
    },
  };
  return parseRuleSet(next);
}

export function sourcesLabel(sources: readonly SourceId[]): string {
  return sources.map((s) => SOURCE_BY_ID[s].label).join(', ');
}
