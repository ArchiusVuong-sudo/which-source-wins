// HTTP API (Hono). Request bodies are validated with zod; errors come back as {error} JSON.

import { readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { FIELD_NAMES, SOURCE_IDS } from '../shared/types.js';
import { MappingError } from './ingest.js';
import { NotFoundError, ValidationError, type Platform } from './platform.js';

const approveBody = z.object({
  columns: z.record(z.string(), z.string().min(1)),
  dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']),
  note: z.string().max(500).default(''),
});

const proposalBody = z.object({
  field: z.enum(FIELD_NAMES),
  sources: z.array(z.enum(SOURCE_IDS)).min(1),
});

const decideBody = proposalBody.extend({
  decision: z.enum(['accepted', 'rejected']),
  reason: z.string().trim().min(3, 'a decision needs a reason').max(500),
});

const scaleBody = z.object({ rows: z.number().int().min(1_000).max(2_000_000).default(1_000_000) });

const idParam = (c: Context) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('bad id');
  return id;
};

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown = {};
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ValidationError('body is not JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export function createApi(platform: Platform): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof ValidationError || err instanceof MappingError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => i.message).join('; ') }, 400);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  api.get('/summary', async (c) => c.json(await platform.summary()));
  api.get('/sources', async (c) => c.json({ sources: platform.sources(), drops: await platform.drops() }));
  api.post('/land', async (c) => c.json(await platform.land()));
  api.get('/drops/:id', async (c) => c.json(await platform.drop(idParam(c))));
  api.post('/drops/:id/approve', async (c) => {
    const b = await body(c, approveBody);
    return c.json(await platform.approve(idParam(c), b.columns, b.dateFormat, b.note));
  });
  api.post('/rebuild', async (c) => c.json(await platform.rebuild('rebuild')));
  api.get('/builds', async (c) => c.json(await platform.builds()));
  api.get('/builds/:id/:kind{(full|delta)\\.ndjson}', (c) => {
    const kind = c.req.param('kind').startsWith('full') ? 'full' : 'delta';
    const id = idParam(c);
    const file = platform.buildFile(id, kind);
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Content-Disposition', `attachment; filename="build-${String(id).padStart(4, '0')}-${kind}.ndjson"`);
    return c.body(readFileSync(file));
  });
  api.get('/vehicles', async (c) => c.json(await platform.vehicles()));
  api.get('/vehicles/:vin', async (c) => c.json(await platform.vehicle(c.req.param('vin'))));
  api.get('/unresolved', async (c) => c.json(await platform.unresolved()));
  api.get('/rules', async (c) => c.json(await platform.rules()));
  api.post('/rules/preview', async (c) => {
    const b = await body(c, proposalBody);
    return c.json(await platform.preview(b.field, b.sources));
  });
  api.post('/rules/decide', async (c) => {
    const b = await body(c, decideBody);
    return c.json(await platform.decide(b.field, b.sources, b.decision, b.reason));
  });
  api.get('/quality', async (c) => c.json(await platform.quality()));
  api.post('/quality/scale', async (c) => {
    const b = await body(c, scaleBody);
    return c.json(await platform.scaleCheck(b.rows));
  });
  api.notFound((c) => c.json({ error: 'not found' }, 404));
  return api;
}
