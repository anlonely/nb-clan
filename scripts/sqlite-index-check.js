#!/usr/bin/env node

import { openSqliteDatabase } from '../server/storage/sqlite.js';
import { ensureSqliteSchema, sqliteJsonFieldIndexes } from '../server/storage/sqlite-migrate.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const sqliteFile = argValue('--sqlite', process.env.NB_SQLITE_FILE || 'data/nb-clan.sqlite');
process.env.NB_STORAGE_MODE ||= 'sqlite';
process.env.NB_SQLITE_FILE = sqliteFile;

const db = await openSqliteDatabase(sqliteFile);
ensureSqliteSchema(db);
const result = sqliteJsonFieldIndexes(db);
const businessMissing = result.businessUniqueConstraints?.missing || [];
console.log(JSON.stringify({
  ok: result.missing.length === 0 && businessMissing.length === 0,
  sqlite: sqliteFile,
  ...result
}, null, 2));

if (result.missing.length || businessMissing.length) {
  process.exitCode = 1;
}
