import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readStoreFromSqlite, sqliteStoreSummary } from '../server/storage/repository.js';

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

const args = parseArgs(process.argv.slice(2));
const source = args.source || 'data/store.json';
const target = args.target || 'data/nb-clan.sqlite';

process.env.NB_SQLITE_FILE = target;
process.env.NB_STORAGE_MODE = process.env.NB_STORAGE_MODE || 'dual';

const sourceStore = JSON.parse(await fs.readFile(source, 'utf8'));
const sqliteStore = await readStoreFromSqlite();
if (!sqliteStore) {
  console.error(JSON.stringify({
    ok: false,
    source: path.resolve(source),
    target: path.resolve(target),
    error: 'SQLite store_full payload not found'
  }, null, 2));
  process.exit(1);
}

const sourceJson = JSON.stringify(sourceStore);
const sqliteJson = JSON.stringify(sqliteStore);
const ok = sourceJson === sqliteJson;
const sqlite = await sqliteStoreSummary();

console.log(JSON.stringify({
  ok,
  source: path.resolve(source),
  target: path.resolve(target),
  sourceBytes: Buffer.byteLength(sourceJson),
  sqliteBytes: Buffer.byteLength(sqliteJson),
  sqlite
}, null, 2));

if (!ok) process.exit(1);

