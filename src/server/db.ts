// PGlite (Postgres in WASM) is a single connection. All app work goes through one queue so a
// multi-step operation (a rebuild, a rule replay) never interleaves with another.

import { mkdirSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { SCHEMA } from './sql.js';

/** Anything we can run SQL on: the database itself or an open transaction. */
export type Sql = Pick<Transaction, 'query' | 'exec'>;

export class Database {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly pg: PGlite) {}

  /** Opens an on-disk database at `dataDir`, or an in-memory one when it is omitted. */
  static async open(dataDir?: string): Promise<Database> {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const pg = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
    await pg.exec(SCHEMA);
    return new Database(pg);
  }

  /** Runs `fn` after every queued operation has finished. */
  exclusive<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(this.pg));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs `fn` inside a transaction, queued like `exclusive`. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.pg.transaction(fn));
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.pg.close();
  }
}

export async function rows<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await sql.query<T>(text, params as never[]);
  return r.rows;
}

export async function one<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T | null> {
  const r = await rows<T>(sql, text, params);
  return r[0] ?? null;
}
