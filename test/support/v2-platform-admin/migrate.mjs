import '../v2-baseline/loopback-only.mjs';
import {readFile,writeFile,mkdir,mkdtemp,chmod} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {root} from './config.mjs';
import {installPlatformAdminSchema} from '../../../server/v2/platform-admin/repository.js';
import {planPlatformMigration,applyPlatformMigration} from '../../../server/v2/platform-admin/migration.js';
// Explicit source path required. No implicit original store or credentials load.
const source=process.argv[2];if(!source)throw new Error('Usage: node test/support/v2-platform-admin/migrate.mjs <authorized-isolated-source.json> [--apply-isolated]');const raw=JSON.parse(await readFile(source,'utf8')),plan=planPlatformMigration(raw);const base=`${root}/test/support/v2-platform-admin/.runtime`;await mkdir(base,{recursive:true,mode:0o700});const out=await mkdtemp(`${base}/migration-`);await writeFile(`${out}/plan.json`,JSON.stringify(plan,null,2),{mode:0o600});let applied=null;if(process.argv.includes('--apply-isolated')){const db=new DatabaseSync(`${out}/isolated.sqlite`);await chmod(`${out}/isolated.sqlite`,0o600);installPlatformAdminSchema(db);applied=applyPlatformMigration({db,plan});const repeat=applyPlatformMigration({db,plan});const integrity=db.prepare('PRAGMA integrity_check').get();await writeFile(`${out}/result.json`,JSON.stringify({applied,repeat,integrity},null,2));db.close();}console.log(JSON.stringify({out,digest:plan.digest,conflicts:plan.conflicts,applied}));
