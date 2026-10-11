// Restores the fresh state: removes the database, landed files and builds. The next start lands
// every source again, quarantines the October registration drop and writes build #1.
import { resolve } from 'node:path';
import { Platform } from '../src/server/platform.js';

const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? '.data');
Platform.reset(dataDir);
console.log(`reset ${dataDir} (decoder data kept)`);
