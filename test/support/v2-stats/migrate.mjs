import { DatabaseSync } from 'node:sqlite';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateStats } from '../../../server/v2/stats/migration.js';
const args = process.argv.slice(2),
  get = key => args[args.indexOf(key) + 1],
  file = await realpath(get('--sqlite'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!file.startsWith(root + '/test/support/v2-stats/.runtime/')) throw new Error('This runner accepts only a copied isolated SQLite under test/support/v2-stats/.runtime/. Production requires a separate reviewed migration owner.');
const dryRun = !args.includes('--apply'),
  db = new DatabaseSync(file, {
    readOnly: dryRun
  });
try {
  console.log(JSON.stringify(migrateStats(db, {
    dryRun,
    after: args.includes('--after') ? get('--after') : '',
    limit: 50
  }), null, 2));
} finally {
  db.close();
}
