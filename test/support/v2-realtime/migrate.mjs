import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealtimeRepository } from '../../../server/v2/realtime/repository.js';
import { migrateLegacyRelay } from '../../../server/v2/realtime/migration.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  args = process.argv.slice(2),
  get = k => args[args.indexOf(k) + 1];
for (const k of ['--sqlite', '--source']) if (!args.includes(k)) throw new Error('Require --sqlite and --source explicitly');
const dbFile = await realpath(get('--sqlite')),
  sourceFile = await realpath(get('--source'));
for (const file of [dbFile, sourceFile]) if (!file.startsWith(root + '/test/support/v2-realtime/.runtime/')) throw new Error('Only explicitly copied isolated inputs under test/support/v2-realtime/.runtime are permitted');
const dryRun = !args.includes('--apply'),
  db = new DatabaseSync(dbFile, {
    readOnly: dryRun
  });
try {
  console.log(JSON.stringify(migrateLegacyRelay(new RealtimeRepository(db), JSON.parse(await readFile(sourceFile, 'utf8')), {
    dryRun,
    after: args.includes('--after') ? Number(get('--after')) : 0,
    limit: 100,
    sourceHash: args.includes('--source-hash') ? get('--source-hash') : undefined
  }), null, 2));
} finally {
  db.close();
}
