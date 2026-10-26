import { mkdir, writeFile } from 'node:fs/promises';
import { createManagedExportRenderer } from '../../../server/v2/management-adapters/exports/index.js';
import { createExportRenderer } from '../../../server/v2/stats/exports.js';

// Constructed public-shaped data only. No database, network credentials or live member data.
const items = Array.from({length:12},(_,i)=>({id:`sample-${i}`,memberId:`sample-${i}`,steamId:`76561198000000${String(i).padStart(3,'0')}`,displayName:i===0?'成员 Alpha / A long display name to verify table wrapping':'Member '+(i+1),squadName:i%2?'Alpha squad':'开荒队伍',sourceId:'vital',serverId:'12',providerWipeId:'2026-09-12',capturedAt:'2026-09-19T12:00:00Z',status:i===11?'unavailable':'stale',capabilities:{assists:false},values:{kills:i===11?null:i===10?0:80-i*5,deaths:i===11?null:i,assists:null,kd:i===11?null:(80-i*5)/Math.max(i,1),kda:null,t3Kills:i===11?null:12-i,rockets:i===11?null:22-i,sulfur:i===11?null:100000-i*6000,metalOre:i===11?null:120000-i*4000,building:i===11?null:350-i*20,onlineSeconds:i===11?null:43200-i*3600,playTimeSeconds:null,steamTotalSeconds:null}}));
const data={wipe:{id:'sample-history',title:'Vital Rust - EU 2x / 2026-09-12 历史档',serverName:'Vital Rust EU 2x',serverId:'12',providerWipeId:'2026-09-12',lifecycle:'ended',startedAt:'2026-09-12T12:00:00Z',closedAt:'2026-09-19T12:00:00Z'},sourceId:'vital',metricVersion:'nb-kda-1',revision:2,dataRevision:'constructed-local-sample',countScope:'authorized_stats_rows',items};
const query={...data,wipe:{id:'sample-query',title:'独立查询结果'},revision:0,items:[{...items[0],values:{...items[0].values,kills:0,deaths:0,kd:0,t3Kills:2,rockets:12,sulfur:36000,metalOre:51000,building:null,onlineSeconds:null}}],countScope:'account_private_query',queryResult:{sourceId:'vital',steamId:items[0].steamId,displayName:items[0].displayName,serverId:'12',providerWipeId:'2026-09-12',status:'fresh',fetchedAt:'2026-09-19T12:00:00Z',categories:[
{id:'combat',fields:[{name:'combat.kills',value:0,status:'observed'},{name:'combat.deaths',value:0,status:'observed'},{name:'combat.assists',value:null,status:'unsupported'},{name:'combat.killsT3',value:2,status:'observed'}]},
{id:'raiding',fields:[{name:'raiding.rockets',value:12,status:'observed'}]},
{id:'farming',fields:[{name:'farming.gathered.sulfur.ore',value:36000,status:'observed'},{name:'farming.gathered.metal.ore',value:51000,status:'observed'}]},
{id:'building',fields:Array.from({length:16},(_,i)=>({name:'building.parts.component_'+i,value:i===15?null:i,status:i===15?'not_observed':'observed'}))},
{id:'pve',fields:[{name:'pve.animalsKilled',value:0,status:'observed'}]}
],errors:[]}};
query.queryResult.fields=query.queryResult.categories.flatMap(category=>category.fields);
const owner=createManagedExportRenderer();
const render=createExportRenderer({renderBinary:owner.renderBinary});
const directory=new URL('../../../output/pdf/',import.meta.url);
await mkdir(directory,{recursive:true});
try {
for(const [name,input,options] of [
['vital-stats-categories-zh',data,{language:'zh',ranking:'all'}],
['vital-stats-sulfur-en',data,{language:'en',ranking:'sulfur'}],
['vital-history-query-en',query,{language:'en'}]
]) {
  for(const format of ['pdf','html']) {
    const result=await render(input,{...options,timeZone:'Asia/Shanghai',format});
    await writeFile(new URL(`${name}.${format}`,directory),Buffer.from(result.base64,'base64'));
    if(format==='pdf') console.log(JSON.stringify({file:`output/pdf/${name}.pdf`,bytes:Buffer.from(result.base64,'base64').length,meta:result.meta}));
  }
}
} finally {await owner.stop();}
