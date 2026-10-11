// Landing, admission and staging.
//   land:   copy each source file to raw/<source>/<drop-date>/<sha256>.<ext>; the same bytes twice is a no-op.
//   admit:  a CSV whose header matches an approved mapping loads; anything else is quarantined.
//   stage:  parsed rows go to stg_* tables; refreshRecords() turns them into source_record rows in SQL.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { ColumnMapping, DriftReport, DropStatus, SourceId } from '../shared/types.js';
import { parseCsv } from './csv.js';
import { rows, one, type Sql } from './db.js';
import { driftReport, parseDate, REGISTRATION_FIELDS, type DateFormat } from './drift.js';

export interface LandedFile {
  id: number;
  source: SourceId;
  dropDate: string;
  key: string;
  ext: string;
  status: DropStatus;
}

export interface LandResult {
  landed: number;
  alreadyLanded: number;
  files: LandedFile[];
}

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})\.(csv|json)$/;
const LANDABLE: readonly SourceId[] = ['registration', 'listing', 'module_read'];

export const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export function landingPath(landingDir: string, key: string): string {
  return join(landingDir, key);
}

/** Lands every file under sourcesDir/<source>/<drop-date>.<ext>. Returns only files new to us. */
export async function landAll(sql: Sql, sourcesDir: string, landingDir: string): Promise<LandResult> {
  const result: LandResult = { landed: 0, alreadyLanded: 0, files: [] };
  for (const source of LANDABLE) {
    const dir = join(sourcesDir, source);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const m = FILE_NAME.exec(name);
      if (!m) continue;
      const [, dropDate, ext] = m as unknown as [string, string, string];
      const bytes = readFileSync(join(dir, name));
      const hash = sha256(bytes);
      const key = `raw/${source}/${dropDate}/${hash}.${ext}`;
      const target = landingPath(landingDir, key);
      if (!existsSync(target)) {
        mkdirSync(join(landingDir, 'raw', source, dropDate), { recursive: true });
        copyFileSync(join(dir, name), target);
      }
      const inserted = await one<{ id: number }>(
        sql,
        `insert into landing_file (source, drop_date, sha256, key, ext, bytes, status)
         values ($1, $2, $3, $4, $5, $6, 'quarantined')
         on conflict (sha256) do nothing returning id`,
        [source, dropDate, hash, key, ext, bytes.length],
      );
      if (!inserted) {
        result.alreadyLanded++;
        continue;
      }
      result.landed++;
      const status = await admit(sql, landingDir, inserted.id);
      result.files.push({ id: inserted.id, source, dropDate, key, ext, status });
    }
  }
  return result;
}

// ---------- admission ----------

const listingSchema = z.object({
  listing_id: z.string().min(1),
  seller: z.string().min(1),
  title: z.string().min(1),
  vin: z.string().nullable(),
  price_cad: z.number().int().nonnegative(),
  km: z.number().int().nonnegative(),
  listed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  colour: z.string().nullable(),
});

const moduleReadSchema = z.object({
  read_id: z.string().min(1),
  device_id: z.string(),
  vin: z.string().nullable(),
  odometer_km: z.number().int().nonnegative(),
  read_at: z.string().datetime(),
  protocol: z.string(),
});

export async function latestMapping(sql: Sql, source: SourceId): Promise<ColumnMapping | null> {
  const r = await one<{ version: number; header: string[]; columns: Record<string, string>; date_format: DateFormat }>(
    sql,
    'select version, header, columns, date_format from column_mapping where source = $1 order by version desc limit 1',
    [source],
  );
  return r ? { version: r.version, source, header: r.header, columns: r.columns, dateFormat: r.date_format } : null;
}

async function mappingForHeader(sql: Sql, source: SourceId, header: string[]): Promise<ColumnMapping | null> {
  const r = await one<{ version: number; header: string[]; columns: Record<string, string>; date_format: DateFormat }>(
    sql,
    'select version, header, columns, date_format from column_mapping where source = $1 and header = $2::jsonb order by version desc limit 1',
    [source, JSON.stringify(header)],
  );
  return r ? { version: r.version, source, header: r.header, columns: r.columns, dateFormat: r.date_format } : null;
}

async function fileInfo(sql: Sql, fileId: number) {
  const f = await one<{ id: number; source: SourceId; key: string; ext: string }>(sql, 'select id, source, key, ext from landing_file where id = $1', [fileId]);
  if (!f) throw new Error(`no landed file ${fileId}`);
  return f;
}

/** Decides whether a landed file loads or waits in quarantine. */
export async function admit(sql: Sql, landingDir: string, fileId: number): Promise<DropStatus> {
  const f = await fileInfo(sql, fileId);
  const text = readFileSync(landingPath(landingDir, f.key), 'utf8');
  if (f.source === 'registration') {
    const table = parseCsv(text);
    const mapping = await mappingForHeader(sql, f.source, table.header);
    if (!mapping) {
      const expected = await latestMapping(sql, f.source);
      if (!expected) throw new Error('no approved registration mapping');
      const report = driftReport(expected, table);
      await sql.query(`update landing_file set status = 'quarantined', rows = $2, drift = $3 where id = $1`, [fileId, table.rows.length, JSON.stringify(report)]);
      return 'quarantined';
    }
    await stageRegistration(sql, fileId, table.header, table.rows, mapping);
    return 'pending_rebuild';
  }
  const data: unknown = JSON.parse(text);
  const schema = f.source === 'listing' ? listingSchema : moduleReadSchema;
  const parsed = z.array(schema).safeParse(data);
  if (!parsed.success) {
    const report: Pick<DriftReport, 'status' | 'blocking'> = {
      status: 'drift',
      blocking: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
    await sql.query(`update landing_file set status = 'quarantined', drift = $2 where id = $1`, [fileId, JSON.stringify(report)]);
    return 'quarantined';
  }
  const items = parsed.data.map((r, i) => ({ row_no: i + 1, ...r }));
  if (f.source === 'listing') {
    await sql.query(
      `insert into stg_listing (file_id, row_no, listing_id, seller, title, vin, price_cad, km, listed_at, colour)
       select $1, x.row_no, x.listing_id, x.seller, x.title, x.vin, x.price_cad, x.km, x.listed_at, x.colour
       from jsonb_to_recordset($2::jsonb) as x(row_no int, listing_id text, seller text, title text, vin text, price_cad int, km int, listed_at date, colour text)`,
      [fileId, JSON.stringify(items)],
    );
  } else {
    await sql.query(
      `insert into stg_module_read (file_id, row_no, read_id, device_id, vin, odometer_km, read_at, protocol)
       select $1, x.row_no, x.read_id, x.device_id, x.vin, x.odometer_km, x.read_at, x.protocol
       from jsonb_to_recordset($2::jsonb) as x(row_no int, read_id text, device_id text, vin text, odometer_km int, read_at timestamptz, protocol text)`,
      [fileId, JSON.stringify(items)],
    );
  }
  await sql.query(`update landing_file set status = 'pending_rebuild', rows = $2, drift = null where id = $1`, [fileId, items.length]);
  return 'pending_rebuild';
}

export class MappingError extends Error {}

/** Applies a mapping to CSV rows and stages them. Fails without writing if any date does not parse. */
export async function stageRegistration(sql: Sql, fileId: number, header: string[], data: string[][], mapping: ColumnMapping): Promise<void> {
  const idx: Record<string, number> = {};
  for (const field of Object.keys(REGISTRATION_FIELDS)) {
    const col = mapping.columns[field];
    const i = col === undefined ? -1 : header.indexOf(col);
    if (i < 0) throw new MappingError(`column for ${field} (${col ?? 'none'}) is not in the file`);
    idx[field] = i;
  }
  const cell = (r: string[], f: string) => (r[idx[f]!] ?? '').trim();
  const items = data.map((r, n) => {
    const date = (f: string) => {
      const raw = cell(r, f);
      if (raw === '') return null;
      const d = parseDate(raw, mapping.dateFormat);
      if (!d) throw new MappingError(`row ${n + 1}: ${mapping.columns[f]} value "${raw}" is not ${mapping.dateFormat}`);
      return d;
    };
    return {
      row_no: n + 1,
      vin: cell(r, 'vin'),
      model_year: cell(r, 'model_year'),
      make: cell(r, 'make'),
      model: cell(r, 'model'),
      colour: cell(r, 'colour'),
      registration_date: date('registration_date'),
      odometer_km: cell(r, 'odometer_km'),
      odometer_date: date('odometer_date'),
      province: cell(r, 'province'),
    };
  });
  await sql.query('delete from stg_registration where file_id = $1', [fileId]);
  await sql.query(
    `insert into stg_registration (file_id, row_no, vin, model_year, make, model, colour, registration_date, odometer_km, odometer_date, province)
     select $1, x.row_no, x.vin, x.model_year, x.make, x.model, x.colour, x.registration_date, x.odometer_km, x.odometer_date, x.province
     from jsonb_to_recordset($2::jsonb) as x(row_no int, vin text, model_year text, make text, model text, colour text,
       registration_date date, odometer_km text, odometer_date date, province text)`,
    [fileId, JSON.stringify(items)],
  );
  await sql.query(`update landing_file set status = 'pending_rebuild', rows = $2, mapping_version = $3, drift = null where id = $1`, [
    fileId,
    items.length,
    mapping.version,
  ]);
}

/** Saves an approved mapping as a new version and loads the quarantined file with it. */
export async function approveMapping(
  sql: Sql,
  landingDir: string,
  fileId: number,
  columns: Record<string, string>,
  dateFormat: DateFormat,
  note: string,
): Promise<ColumnMapping> {
  const f = await one<{ source: SourceId; key: string; status: DropStatus }>(sql, 'select source, key, status from landing_file where id = $1', [fileId]);
  if (!f) throw new MappingError('no such drop');
  if (f.status !== 'quarantined') throw new MappingError('this drop is not quarantined');
  if (f.source !== 'registration') throw new MappingError('only CSV drops take a column mapping');
  const table = parseCsv(readFileSync(landingPath(landingDir, f.key), 'utf8'));
  const chosen = Object.values(columns);
  if (new Set(chosen).size !== chosen.length) throw new MappingError('a column is mapped to two fields');
  const prev = await latestMapping(sql, f.source);
  const mapping: ColumnMapping = { version: (prev?.version ?? 0) + 1, source: f.source, header: table.header, columns, dateFormat };
  await stageRegistration(sql, fileId, table.header, table.rows, mapping);
  await sql.query('insert into column_mapping (source, version, header, columns, date_format, note) values ($1, $2, $3, $4, $5, $6)', [
    mapping.source,
    mapping.version,
    JSON.stringify(mapping.header),
    JSON.stringify(mapping.columns),
    mapping.dateFormat,
    note,
  ]);
  return mapping;
}

export async function seedMapping(sql: Sql, mapping: ColumnMapping): Promise<void> {
  await sql.query(
    'insert into column_mapping (source, version, header, columns, date_format, note) values ($1, $2, $3, $4, $5, $6) on conflict do nothing',
    [mapping.source, mapping.version, JSON.stringify(mapping.header), JSON.stringify(mapping.columns), mapping.dateFormat, 'seeded from data/mappings'],
  );
}

/** Rebuilds source_record from every staged, non-quarantined drop. All normalisation is SQL. */
export async function refreshRecords(sql: Sql): Promise<number> {
  await sql.exec('delete from match_link; delete from match_unresolved; delete from source_record;');
  await sql.exec(`
    insert into source_record (record_id, source, tier, file_id, vin_raw, vin_norm, vin_check_ok, make_raw, make, model_raw, model,
      model_year, colour, km, observed_at, province, registration_date, payload)
    select 'registration:' || to_char(f.drop_date, 'YYYY-MM-DD') || ':' || s.row_no, 'registration', src.tier, s.file_id,
      nullif(s.vin, ''), vin_norm(s.vin), vin_check_ok(vin_norm(s.vin)),
      s.make, coalesce(a.make, initcap(s.make)), s.model, nullif(s.model, ''),
      nullif(s.model_year, '')::int, initcap(nullif(s.colour, '')), nullif(s.odometer_km, '')::int, s.odometer_date,
      upper(nullif(s.province, '')), s.registration_date,
      to_jsonb(s) - 'file_id' || jsonb_build_object('drop', to_char(f.drop_date, 'YYYY-MM-DD'))
    from stg_registration s
    join landing_file f on f.id = s.file_id and f.status <> 'quarantined'
    join source src on src.id = 'registration'
    left join make_alias a on a.alias = trim(words(s.make)) and a.model is null;

    insert into source_record (record_id, source, tier, file_id, vin_raw, vin_norm, vin_check_ok, make_raw, make, model_raw, model,
      model_year, colour, km, observed_at, seller, title, observed_trim, payload)
    select 'listing:' || s.listing_id, 'listing', src.tier, s.file_id,
      nullif(s.vin, ''), vin_norm(s.vin), vin_check_ok(vin_norm(s.vin)),
      initcap(mk.alias), mk.make, md.alias, md.model,
      substring(s.title from '\\m(?:19|20)\\d{2}\\M')::int, initcap(s.colour), s.km, s.listed_at, s.seller, s.title, tw.word,
      to_jsonb(s) - 'file_id'
    from stg_listing s
    join landing_file f on f.id = s.file_id and f.status <> 'quarantined'
    join source src on src.id = 'listing'
    left join lateral (
      select a.alias, a.make from make_alias a where words(s.title) like '% ' || a.alias || ' %' order by length(a.alias) desc limit 1
    ) mk on true
    left join lateral (
      select a.alias, a.model from make_alias a where a.model is not null and words(s.title) like '% ' || a.alias || ' %'
      order by length(a.alias) desc limit 1
    ) md on true
    left join lateral (
      select t.word from trim_word t where words(s.title) like '%' || words(t.word) || '%' order by length(t.word) desc limit 1
    ) tw on true;

    insert into source_record (record_id, source, tier, file_id, vin_raw, vin_norm, vin_check_ok, km, observed_at, payload)
    select 'module_read:' || s.read_id, 'module_read', src.tier, s.file_id,
      nullif(s.vin, ''), vin_norm(s.vin), vin_check_ok(vin_norm(s.vin)), s.odometer_km, (s.read_at at time zone 'UTC')::date,
      to_jsonb(s) - 'file_id'
    from stg_module_read s
    join landing_file f on f.id = s.file_id and f.status <> 'quarantined'
    join source src on src.id = 'module_read';
  `);
  const r = await rows<{ n: number }>(sql, 'select count(*)::int as n from source_record');
  return r[0]?.n ?? 0;
}
