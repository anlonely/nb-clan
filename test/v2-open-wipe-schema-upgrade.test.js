import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureSqliteSchema, upsertSqliteCollectionRecord, upsertSqliteScalar, readSqliteScalar } from '../server/storage/sqlite-migrate.js';
import { planProductionMigration, applyProductionMigration, validateProductionReady, acquireProductionLease } from '../server/v2/production/migrations.js';
import { enableOpenWipeSchema } from '../scripts/v2-production/enable-open-wipe-schema.mjs';
import { OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';

const ownMarkers=new Set(['v2NotificationOpenWipeSchemaVersion','v2NotificationOpenWipeMigration']);
const code=expected=>error=>error.errorCode===expected;
const receipt=async c=>({kind:'isolated-copy',sourcePath:'/never-opened/authorized-source.sqlite',databaseSha256:createHash('sha256').update(await fs.readFile(c.databaseFile)).digest('hex'),observedAt:new Date().toISOString()});
function state(file,ignoreNewMarkers=false){
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const schema=db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return {schema,rows:Object.fromEntries(schema.filter(row=>row.type==='table').map(({name})=>[name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all().filter(row=>!ignoreNewMarkers||name!=='json_scalars'||!ownMarkers.has(row.key))]))};
  } finally {db.close();}
}
async function fixture(t,{removeMarker=true}={}){
  const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nb-open-wipe-upgrade-'));await fs.chmod(dir,0o700);
  const c={dataDirectory:dir,databaseFile:path.join(dir,'nb-clan.sqlite')};
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let db=new DatabaseSync(c.databaseFile);ensureSqliteSchema(db);upsertSqliteScalar(db,'settings',{});
  // Current owner authority is a verified binding, not the legacy username.
  upsertSqliteCollectionRecord(db,'members','fixture-owner',{id:'fixture-owner',steamId:OWNER_STEAM_ID,memberStatus:'active',kookId:'fixture-owner-kook'});
  upsertSqliteCollectionRecord(db,'users','user_root',{id:'user_root',username:'root',role:'admin',passwordHash:'preserved-test-hash',status:'active',boundSteamId:OWNER_STEAM_ID,
    loginProviders:{kook:{id:'fixture-owner-kook',verifiedSteamId:OWNER_STEAM_ID,steamVerifiedAt:'2026-01-01T00:00:00Z'}}});
  db.close();await fs.chmod(c.databaseFile,0o600);
  const plan=await planProductionMigration(c),lease=await acquireProductionLease(c,{mode:'maintenance',stopReceipt:await receipt(c)});
  try{await applyProductionMigration(c,plan,{expectedDigest:plan.digest,operatorId:'user_root',maintenanceLease:lease});}finally{await lease.release();}
  if(removeMarker){db=new DatabaseSync(c.databaseFile);for(const key of ownMarkers)db.prepare('DELETE FROM json_scalars WHERE key=?').run(key);db.close();}
  await validateProductionReady(c);
  const receiptFile=path.join(dir,'.v2-production','stop-receipt.json');
  const writeReceipt=async overrides=>{await fs.writeFile(receiptFile,JSON.stringify({...await receipt(c),...overrides}),{mode:0o600});return receiptFile;};
  await writeReceipt();return {c,receiptFile,writeReceipt};
}

test('explicit open-wipe upgrade backs up old production and adds only its two independent markers',async t=>{
  const f=await fixture(t),before=state(f.c.databaseFile),preserved=state(f.c.databaseFile,true);
  const result=await enableOpenWipeSchema(f.c,f.receiptFile);
  assert.equal(result.installed,true);assert.equal(result.replayed,false);
  assert.equal(path.dirname(result.backupFile),path.join(f.c.dataDirectory,'.v2-production'));
  assert.match(path.basename(result.backupFile),/^before-open-wipe-.*\.sqlite$/);
  assert.equal((await fs.stat(result.backupFile)).mode&0o777,0o600);
  assert.deepEqual(state(result.backupFile),before,'backup contains the exact pre-upgrade database contents');
  assert.deepEqual(state(f.c.databaseFile,true),preserved,'identity, signup, platform configuration and other markers are unchanged');
  const db=new DatabaseSync(f.c.databaseFile,{readOnly:true});
  assert.equal(readSqliteScalar(db,'v2NotificationOpenWipeSchemaVersion'),1);
  assert.equal(readSqliteScalar(db,'v2NotificationOpenWipeMigration').resourceKind,'discordOpenWipe');db.close();
  await validateProductionReady(f.c);
  await assert.rejects(fs.stat(path.join(f.c.dataDirectory,'.v2-production','operation.lock')),error=>error.code==='ENOENT');
  const after=state(f.c.databaseFile);await f.writeReceipt();
  const replay=await enableOpenWipeSchema(f.c,f.receiptFile);
  assert.equal(replay.replayed,true);assert.notEqual(replay.backupFile,result.backupFile);assert.deepEqual(state(f.c.databaseFile),after);
});

test('missing private receipt, stale stop evidence and an active owner deny the upgrade before database writes',async t=>{
  const f=await fixture(t),before=state(f.c.databaseFile);
  await fs.chmod(f.receiptFile,0o644);
  await assert.rejects(enableOpenWipeSchema(f.c,f.receiptFile),code('PRIVATE_STOP_RECEIPT_REQUIRED'));await fs.chmod(f.receiptFile,0o600);
  await f.writeReceipt({observedAt:'2000-01-01T00:00:00Z'});
  await assert.rejects(enableOpenWipeSchema(f.c,f.receiptFile),code('PRODUCTION_STOP_RECEIPT_REQUIRED'));
  await f.writeReceipt();const owner=await acquireProductionLease(f.c,{mode:'runtime'});
  try{await assert.rejects(enableOpenWipeSchema(f.c,f.receiptFile),code('PRODUCTION_IN_USE'));}finally{await owner.release();}
  assert.deepEqual(state(f.c.databaseFile),before);
  assert.equal((await fs.readdir(path.join(f.c.dataDirectory,'.v2-production'))).filter(name=>name.startsWith('before-open-wipe-')).length,0);
});

test('an inconsistent preexisting open-wipe marker is rejected without changing other production state',async t=>{
  const f=await fixture(t),db=new DatabaseSync(f.c.databaseFile);
  upsertSqliteScalar(db,'v2NotificationOpenWipeSchemaVersion',2);db.close();await f.writeReceipt();
  const before=state(f.c.databaseFile);
  await assert.rejects(enableOpenWipeSchema(f.c,f.receiptFile),code('OPEN_WIPE_SCHEMA_STATE_INVALID'));
  assert.deepEqual(state(f.c.databaseFile),before);
  await assert.rejects(fs.stat(path.join(f.c.dataDirectory,'.v2-production','operation.lock')),error=>error.code==='ENOENT');
});

test('the shared candidate and production migration installer includes open-wipe markers for new databases',async t=>{
  const f=await fixture(t,{removeMarker:false}),db=new DatabaseSync(f.c.databaseFile,{readOnly:true});
  assert.equal(readSqliteScalar(db,'v2NotificationOpenWipeSchemaVersion'),1);
  assert.equal(readSqliteScalar(db,'v2NotificationOpenWipeMigration').schemaVersion,1);db.close();
});
