// The main flow over HTTP, as the UI drives it: quarantine, approve, rebuild, inspect, replay, reject, score.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildSummary, DriftReport, GoldenRecord, QualityReport, RulePreview, Summary, VehicleDetail } from '../src/shared/types.js';
import { createApi } from '../src/server/http.js';
import { HERO, openPlatform } from './helpers.js';

let api: ReturnType<typeof createApi>;
let close: () => Promise<void>;
beforeAll(async () => {
  const p = await openPlatform();
  close = p.close;
  api = createApi(p.platform);
});
afterAll(async () => close());

async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await api.request(path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  return { status: res.status, data: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T };
}

describe('main flow over the API', () => {
  it('runs from a quarantined drop to a rejected rule change', async () => {
    const s0 = (await call<Summary>('/summary')).data;
    expect(s0).toMatchObject({ buildId: 1, quarantined: 1, ruleSetVersion: 1 });

    const sources = (await call<{ drops: { id: number; status: string }[] }>('/sources')).data;
    const q = sources.drops.find((d) => d.status === 'quarantined')!;
    const drop = (await call<{ drift: DriftReport; nextMappingVersion: number }>(`/drops/${q.id}`)).data;
    expect(drop.nextMappingVersion).toBe(2);
    expect(drop.drift.dateFormat).toBe('DD/MM/YYYY');

    const bad = await call<{ error: string }>(`/drops/${q.id}/approve`, { columns: { vin: 'VIN_NO' }, dateFormat: 'DD/MM/YYYY' });
    expect(bad.status).toBe(400);

    const columns = Object.fromEntries(drop.drift.proposal.map((p) => [p.field, p.column]));
    const ok = await call<{ version: number }>(`/drops/${q.id}/approve`, { columns, dateFormat: drop.drift.dateFormat, note: 'e2e' });
    expect(ok.status).toBe(200);
    expect(ok.data.version).toBe(2);

    const build = (await call<BuildSummary>('/rebuild', {})).data;
    expect(build.id).toBe(2);
    const full = await api.request(`/builds/${build.id}/full.ndjson`);
    const fullText = await full.text();
    expect(full.headers.get('content-type')).toMatch(/ndjson/);
    expect(createHash('sha256').update(fullText).digest('hex')).toBe(build.full.sha256);
    const first = JSON.parse(fullText.split('\n')[0]!) as GoldenRecord;
    expect(Object.keys(first.fields.make)).toEqual(['value', 'source', 'tier', 'asOf', 'ruleId', 'ruleVersion', 'alsoReported', 'conflict', 'reason', 'flags', 'recordId', 'pattern']);

    const hero = (await call<VehicleDetail>(`/vehicles/${HERO}`)).data;
    expect(hero.golden.fields.trim.value).toBe('Classic DS');
    expect(hero.golden.fields.odometerKm.value).toBe(91_300);
    expect((await call(`/vehicles/NOPE`)).status).toBe(404);

    const preview = (await call<RulePreview>('/rules/preview', { field: 'trim', sources: ['vin_pattern', 'listing'] })).data;
    expect(preview.after.wrong).toBeGreaterThan(0);
    expect((await call('/rules/decide', { field: 'trim', sources: ['vin_pattern', 'listing'], decision: 'rejected', reason: '' })).status).toBe(400);
    const decided = await call<{ decision: { id: number; reason: string } }>('/rules/decide', {
      field: 'trim',
      sources: ['vin_pattern', 'listing'],
      decision: 'rejected',
      reason: 'seller trims are wrong too often',
    });
    expect(decided.status).toBe(200);
    expect(decided.data.decision.reason).toBe('seller trims are wrong too often');

    const quality = (await call<QualityReport>('/quality')).data;
    expect(quality.errors.map((e) => e.caseLabel).sort()).toEqual(['Classic vs new generation', 'Fleet twins', 'Pasted VIN']);
    expect((await call<Summary>('/summary')).data).toMatchObject({ buildId: 2, quarantined: 0, ruleSetVersion: 1 });
  });

  it('rejects malformed bodies', async () => {
    expect((await call('/rules/preview', { field: 'colour', sources: ['nowhere'] })).status).toBe(400);
    expect((await api.request('/rules/preview', { method: 'POST', body: '{not json' })).status).toBe(400);
  });
});
