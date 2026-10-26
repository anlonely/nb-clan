import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeSqliteStoreMirror, sqliteStoreSummary } from '../server/storage/repository.js';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  console.error('Usage: node scripts/sqlite-migrate-store.js --source data/store.json --target data/nb-clan.sqlite --mode dry-run|apply');
}

function topLevelArrayCounts(store) {
  return Object.fromEntries(Object.entries(store || {})
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [key, value.length]));
}

const args = parseArgs(process.argv.slice(2));
const source = args.source || 'data/store.json';
const target = args.target || 'data/nb-clan.sqlite';
const mode = args.mode || 'dry-run';

if (!['dry-run', 'apply'].includes(mode)) {
  usage();
  process.exit(2);
}

const raw = await fs.readFile(source, 'utf8');
const store = JSON.parse(raw);
const summary = {
  source: path.resolve(source),
  target: path.resolve(target),
  mode,
  version: store.version || null,
  updatedAt: store.updatedAt || '',
  counts: topLevelArrayCounts(store)
};

if (mode === 'dry-run') {
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  process.exit(0);
}

process.env.NB_SQLITE_FILE = target;
process.env.NB_STORAGE_MODE = process.env.NB_STORAGE_MODE || 'dual';

await writeSqliteStoreMirror(store, { reason: 'sqlite_migrate_store' });
const sqlite = await sqliteStoreSummary();
console.log(JSON.stringify({ ok: true, ...summary, sqlite }, null, 2));

