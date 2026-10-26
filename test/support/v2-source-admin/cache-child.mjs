import '../v2-baseline/loopback-only.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const directory=process.argv[2];assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith('g07-source-cache-'));
// Explicit isolated paths before any original store import. No dotenv or live configuration.
process.env.NB_STORAGE_MODE='sqlite-primary';process.env.NB_DATA_DIR=directory;process.env.NB_SQLITE_FILE=path.join(directory,'fixture.sqlite');
const {fixture}=await import('../v2-system-admin/fixtures.mjs');
const {readStore,patchStoreCache}=await import('../../../server/store.js');
const {readSettingsRuntimeStore}=await import('../../../server/settings-store.js');
const {closeSqliteDatabasesForTests}=await import('../../../server/storage/sqlite.js');
const {createSourceAdmin,installSourceAdminSchema}=await import('../../../server/v2/source-admin/index.js');
const f=await fixture(directory);installSourceAdminSchema(f.db,{apply:true});let fail=true;
const admin=createSourceAdmin({identity:f.identity,patchStoreCache:async mutator=>{if(fail)throw Error('synthetic-cache-interruption');return patchStoreCache(mutator);}});admin.start();
try {
  const initial=await readStore();assert.equal(initial.settings.steamWebApi.apiKey,'');
  const id=randomUUID(),input={expectedRevision:admin.read(f.actor('root'),'steam').revision,apiKey:'synthetic-original-cache-key'};
  await assert.rejects(admin.command(f.actor('root'),'steam.save',input,id),e=>e.errorCode==='CACHE_REFRESH_REQUIRED');
  assert.equal((await readSettingsRuntimeStore()).settings.steamWebApi.apiKey,input.apiKey);
  assert.equal((await readStore()).settings.steamWebApi.apiKey,'');
  fail=false;await admin.recover(f.actor('root'),id);
  assert.equal((await readStore()).settings.steamWebApi.apiKey,input.apiKey);
  assert.equal((await readSettingsRuntimeStore()).settings.steamWebApi.apiKey,input.apiKey);
  assert.deepEqual((await readStore()).settings.discord,initial.settings.discord);
  console.log(JSON.stringify({canonicalSettingsReader:true,originalStoreCache:true,replayRepaired:true,isolatedOnly:true}));
}finally{await admin.stop();await closeSqliteDatabasesForTests();await f.close();}
