// Server entry: the API under /api and the built React app from dist/web, on 127.0.0.1:4112.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './http.js';
import { Platform } from './platform.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.PORT ?? 4112);
const hostname = process.env.HOST ?? '127.0.0.1';
const dataDir = resolve(root, process.env.DATA_DIR ?? '.data');
const webDir = join(root, 'dist', 'web');

const started = performance.now();
const platform = await Platform.open({ root, dataDir });
const app = new Hono();
app.route('/api', createApi(platform));
if (existsSync(webDir)) {
  const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
  app.use('/assets/*', serveStatic({ root: webDir }));
  app.get('/favicon.svg', serveStatic({ root: webDir }));
  app.get('*', (c) => c.html(indexHtml));
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`which-source-wins ready on http://${info.address}:${info.port} (${Math.round(performance.now() - started)} ms)`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await platform.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
