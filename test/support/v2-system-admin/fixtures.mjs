import '../owner-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { AuthContexts } from '../../../server/v2/identity/contexts.js';
import { legacyFingerprint } from '../../../server/v2/identity/migration.js';
import { CAPABILITIES, grant, migrateLegacyGrants, OWNER_STEAM_ID, roleGrants } from '../../../server/v2/identity/permissions.js';
import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';
import { migrateSystemAdmin } from '../../../server/v2/system-admin/repository.js';
import { createLocalSystemStorage } from '../../../server/v2/system-admin/storage.js';
import { createSystemIdentityAdapter } from '../../../server/v2/system-admin/identity-adapter.js';
import { createSystemWriteOwner, SystemAdminService } from '../../../server/v2/system-admin/service.js';
import { hashSecret } from '../../../server/v2/system-admin/model.js';
export async function fixture(directory, options = {}) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700}); directory=fs.realpathSync(directory); const databaseFile = path.join(directory,'fixture.sqlite');
  const db = new DatabaseSync(databaseFile); db.exec('PRAGMA journal_mode=WAL'); installIdentitySchema(db);
  const repo = new IdentityRepository(db); repo.setScalar('v2IdentityMigration',{isolated:true});
  const identity = new IdentityService(repo), contexts = new AuthContexts();
  const passwordHash = await hashSecret('Fixture-only-Password-2026');
  for (const [id,role] of [['root','admin'],['admin','admin'],['operator','member_manager'],['viewer','viewer'],['member','member']]) {
    const user = {id:id==='root'?'user_root':`legacy_${id}`,username:id,role,passwordHash,createdAt:'2026-09-08T00:00:00.000Z'};
    repo.put('users',user);
    const grants = id === 'operator' ? [grant('system.accounts',{type:'all'}),grant('system.brand',{type:'all'})] : migrateLegacyGrants(user,{permissionRoles:[]}).grants;
    repo.put('accounts',{id,legacyUserId:user.id,legacyFingerprint:legacyFingerprint(user,[]),roleId:role,adminAssignedByOwner:id==='admin',status:'active',memberId:null,revision:1,permissionVersion:1,grants});
  }
  if (options.trustedRoot !== false) {
    repo.put('members',{id:'fixture-owner-member',steamId:OWNER_STEAM_ID,revision:1});
    repo.put('bindings',{id:'fixture-owner-binding',accountId:'root',memberId:'fixture-owner-member',steamId:OWNER_STEAM_ID,status:'verified',revision:1});
    repo.put('accounts',{...repo.get('accounts','root'),memberId:'fixture-owner-member',roleId:'owner',grants:roleGrants('owner')});
  }
  // All capabilities do not establish root. Used for root-only regression tests.
  repo.put('accounts',{id:'impostor',roleId:'admin',status:'active',memberId:null,revision:1,permissionVersion:1,grants:CAPABILITIES.map(c=>grant(c,{type:'all'}))});
  repo.setScalar('settings',{system:{teamLogoUrl:'',proxy:{url:'',scope:'global'}},publicApi:{tokenHash:''},
    battlemetrics:{apiKey:'fixture-source-key-not-for-browser'},discord:{botToken:'fixture-bot-secret-not-for-browser'}});
  for (let i=0;i<75;i++) upsertSqliteCollectionRecord(db,'logs',`log${String(i).padStart(3,'0')}`,{
    id:`log${String(i).padStart(3,'0')}`,createdAt:`2026-09-08T02:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`,
    type:i%2?'system_settings_edit':'login',actorUsername:'root',summary:i%2?'更新战队徽标':'登录管理工作台',ip:'private-ip',metadata:{token:'must-not-return'}});
  upsertSqliteCollectionRecord(db,'operationRuns','op-fixture',{id:'op-fixture',type:'config_test',createdAt:'2026-09-08T02:02:00.000Z',status:'failed',errorSummary:'token=fixture-probe-secret',metadata:{secret:'must-not-return'}});
  migrateSystemAdmin(db,{apply:true});
  const artifactDir=path.join(directory,'artifacts');fs.mkdirSync(artifactDir,{mode:0o700});
  const storage=createLocalSystemStorage({db,directory:artifactDir,databaseFile});
  let queue=Promise.resolve(), patches=0, invalidations=0;
  const owner=createSystemWriteOwner({runWrite:fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;},
    patchCache:async change=>{patches++;if(options.patchCache)await options.patchCache(change);},
    invalidateAuthContexts:()=>{invalidations++;contexts.entries.clear();}});
  owner.start();
  const probes=[];
  const service=new SystemAdminService({identity,identityAdmin:createSystemIdentityAdapter(identity),owner,storage,
    proxyEnvironment:{global:'http://env-user:env-secret@127.0.0.1:19001'},
    ...(options.proxyNodes ? { proxyNodes: options.proxyNodes } : {}),
    probe:options.probe || (async ({service,operationId})=>{probes.push({service,operationId});return {status:'reachable',httpStatus:200,durationMs:1};})});
  return {db,repo,identity,contexts,owner,storage,service,databaseFile,artifactDir,probes,
    counters:()=>({patches,invalidations}),actor:id=>identity.actorForAccount(id),
    close:async()=>{await owner.stop();db.close();}};
}
