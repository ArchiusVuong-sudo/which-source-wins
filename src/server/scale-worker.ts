// Worker thread entry for the scale check, so the 1,000,000-row run never blocks the API.
import { parentPort, workerData } from 'node:worker_threads';
import { runScaleCheck } from './scale.js';

const rowsWanted = typeof workerData?.rows === 'number' ? workerData.rows : 1_000_000;
runScaleCheck(rowsWanted).then(
  (report) => parentPort?.postMessage({ ok: true, report }),
  (err: unknown) => parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
