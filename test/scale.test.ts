import { describe, expect, it } from 'vitest';
import { runScaleCheck } from '../src/server/scale.js';

const walk = (n: { nodeType: string; index: string | null; children: unknown[] }): string[] => [
  `${n.nodeType}${n.index ? ` ${n.index}` : ''}`,
  ...(n.children as (typeof n)[]).flatMap(walk),
];

describe('scale check', () => {
  it('plans the blocking query without and with the composite index on generated rows', async () => {
    const r = await runScaleCheck(30_000);
    expect(r.rows).toBe(30_000);
    expect(walk(r.withoutIndex.plan).join(' ')).not.toMatch(/record_scale_block/);
    expect(walk(r.withIndex.plan).join(' ')).toMatch(/record_scale_block/);
    expect(r.withIndex.resultRows).toBe(r.withoutIndex.resultRows);
    expect(r.withoutIndex.executionMs).toBeGreaterThan(0);
  }, 60_000);
});
