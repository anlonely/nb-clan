import '../results.mjs';
import {DatabaseSync} from 'node:sqlite';
import {Session} from 'node:inspector/promises';
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {installIdentitySchema,IdentityRepository} from '../../../server/v2/identity/repository.js';
import {applyIdentityMigration,planIdentityMigration} from '../../../server/v2/identity/migration.js';
import {IdentityService} from '../../../server/v2/identity/service.js';
import {installSchedulingSchema,SchedulingRepository} from '../../../server/v2/scheduling/repository.js';
import {applySchedulingMigration,planSchedulingMigration} from '../../../server/v2/scheduling/migration.js';
import {SchedulingService} from '../../../server/v2/scheduling/service.js';
import {installRealtimeSchema,RealtimeRepository} from '../../../server/v2/realtime/repository.js';
import {seed} from './seed.mjs';
const db=new DatabaseSync(':memory:');
try{
  installIdentitySchema(db);const ir=new IdentityRepository(db);applyIdentityMigration(ir,planIdentityMigration({}));
  installSchedulingSchema(db);const sr=new SchedulingRepository(db);applySchedulingMigration(sr,planSchedulingMigration({}));installRealtimeSchema(db);
  const identity=new IdentityService(ir),scheduling=new SchedulingService(sr,identity);
  seed({identity,system:{scheduling,realtime:{repository:new RealtimeRepository(db)}},scale:5,cursorCount:2});
  const readTimes={};for(const [repo,method] of [[ir,'all'],[sr,'forWipe']]){const fn=repo[method];repo[method]=function(...args){const begin=performance.now(),value=fn.apply(this,args),key=method+':'+args[0];const row=readTimes[key]||={n:0,ms:0};row.n++;row.ms+=performance.now()-begin;return value;};}
  const actor=identity.actorForAccount('g08_account_0'),wipe=scheduling.wipe('fixture_wipe_0');
  const session=new Session();session.connect();await session.post('Profiler.enable');await session.post('Profiler.start');
  const started=performance.now();for(let n=0;n<150;n++)scheduling.roster(actor,wipe);
  const elapsedMs=performance.now()-started,{profile}=await session.post('Profiler.stop');session.disconnect();
  const nodes=new Map(profile.nodes.map(n=>[n.id,n])),totals=new Map();
  for(let i=0;i<profile.samples.length;i++){const n=nodes.get(profile.samples[i]),f=n.callFrame,key=f.url+':'+(f.lineNumber+1)+' '+f.functionName;totals.set(key,(totals.get(key)||0)+profile.timeDeltas[i]);}
  const top=[...totals].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([frame,microseconds])=>({frame,ms:microseconds/1000}));
  const result={readTimes,calls:150,elapsedMs,perCallMs:elapsedMs/150,top};await fs.writeFile('output/test-results/g08/roster-profile.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{db.close();}
