// Rule replay: a proposal writes nothing, is scored against the truth, and every decision needs a reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one } from '../src/server/db.js';
import { parseRuleSet, proposeFieldChange, loadSeedRules } from '../src/server/rules.js';
import type { Platform } from '../src/server/platform.js';
import { ROOT, openPlatform } from './helpers.js';
import { join } from 'node:path';

let platform: Platform;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ platform, close } = await openPlatform());
});
afterAll(async () => close());

const state = () =>
  platform.db.exclusive(async (sql) => ({
    ruleSets: (await one<{ n: number }>(sql, 'select count(*)::int as n from rule_set'))!.n,
    active: (await one<{ v: number }>(sql, 'select version as v from rule_set where active'))!.v,
    decisions: (await one<{ n: number }>(sql, 'select count(*)::int as n from decision'))!.n,
    builds: (await one<{ n: number }>(sql, 'select count(*)::int as n from build'))!.n,
    observations: (await one<{ n: number }>(sql, 'select count(*)::int as n from observation'))!.n,
  }));

describe('rule set schema', () => {
  it('loads v1 and refuses a source that is not allowed for the field', () => {
    const v1 = loadSeedRules(join(ROOT, 'rules/v1.json'));
    expect(v1.fields.trim.sources).toEqual(['vin_pattern']);
    expect(() => proposeFieldChange(v1, 'registeredProvince', ['listing'])).toThrow(/not allowed/);
    expect(() => parseRuleSet({ ...v1, fields: { ...v1.fields, trim: { ...v1.fields.trim, sources: ['vin_pattern', 'vin_pattern'] } } })).toThrow(/twice/);
  });

  it('names a changed rule after its new source order', () => {
    const v1 = loadSeedRules(join(ROOT, 'rules/v1.json'));
    const next = proposeFieldChange(v1, 'trim', ['vin_pattern', 'listing']);
    expect(next.fields.trim).toMatchObject({ id: 'trim.pattern-then-seller', version: 2 });
    expect(next.version).toBe(2);
  });
});

describe('replay', () => {
  it('scores "VIN pattern, then seller text" against the truth and writes nothing', async () => {
    const before = await state();
    const vehicleBefore = await platform.vehicles();
    const p = await platform.preview('trim', ['vin_pattern', 'listing']);
    expect(p.rolledBack).toBe(true);
    expect(p.before.wrong).toBe(0);
    expect(p.after.wrong).toBeGreaterThan(0);
    expect(p.after.correct).toBeGreaterThan(p.before.correct);
    expect(p.changes.length).toBeGreaterThan(0);
    expect(p.changes.every((c) => c.before === null && c.afterSource === 'listing')).toBe(true);
    expect(p.wrongAfter.every((c) => c.after !== c.truth)).toBe(true);
    expect(await state()).toEqual(before);
    expect(await platform.vehicles()).toEqual(vehicleBefore);
  });

  it('needs a reason for a decision', async () => {
    await expect(platform.decide('trim', ['vin_pattern', 'listing'], 'rejected', '   ')).rejects.toThrow(/reason/);
  });

  it('logs a rejection and leaves the rule as it is', async () => {
    const before = await state();
    const r = await platform.decide('trim', ['vin_pattern', 'listing'], 'rejected', 'seller trims are wrong too often');
    expect(r.build).toBeNull();
    expect(r.decision).toMatchObject({ decision: 'rejected', ruleId: 'trim.pattern-only', proposedRuleId: 'trim.pattern-then-seller', fromVersion: 1, proposedVersion: 2 });
    expect(r.decision.after.wrong).toBeGreaterThan(0);
    const after = await state();
    expect(after).toEqual({ ...before, decisions: before.decisions + 1 });
  });

  it('accepts with a reason, bumps the rule version and writes a build with its delta', async () => {
    const r = await platform.decide('trim', ['vin_pattern', 'listing'], 'accepted', 'testing an accepted change');
    expect(r.build).not.toBeNull();
    expect(r.build!.trigger).toBe('rule accepted: trim.pattern-then-seller v2');
    expect(r.build!.delta.rows).toBeGreaterThan(0);
    const { rules, decisions } = await platform.rules();
    expect(rules.version).toBe(2);
    expect(rules.fields.trim).toMatchObject({ id: 'trim.pattern-then-seller', version: 2 });
    expect(decisions[0]).toMatchObject({ decision: 'accepted', buildId: r.build!.id });
  });

  it('refuses a proposal that does not change the rule', async () => {
    await expect(platform.decide('trim', ['vin_pattern', 'listing'], 'accepted', 'no-op')).rejects.toThrow(/does not change/);
  });
});
