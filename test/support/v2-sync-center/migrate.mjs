import '../v2-baseline/loopback-only.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {planSyncCenterMigration} from '../../../server/v2/sync-center/migration.js';
// Offline dry-run only. Apply is the explicit exported service function, inside the caller's authority serialization.
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: node test/support/v2-sync-center/migrate.mjs <sanitized-source.json> <plan.json>');
const raw=await readFile(input,'utf8');if(Buffer.byteLength(raw)>8*1024*1024)throw new Error('Migration input exceeds 8 MiB');
const plan=planSyncCenterMigration(JSON.parse(raw));await writeFile(output,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({jobs:plan.jobs.length,rules:plan.rules.length,runs:plan.runs.length,conflicts:plan.conflicts.length,sourceHash:plan.sourceHash}));
