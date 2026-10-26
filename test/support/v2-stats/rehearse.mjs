import '../results.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {fixture} from './fixture.mjs';
import {migrateStats} from '../../../server/v2/stats/migration.js';
const f=fixture();try{
 const row=f.service.repo.get('kdaRows','g07_history:g05_alpha');
 f.put('wipeSettlements',{id:'isolated_legacy_settlement',wipeId:'g07_history',generatedAt:'2026-09-01T12:00:00.000Z',kdaSnapshot:[row],participantsSnapshot:[{memberId:'g05_alpha',displayName:'归档时的阿北',status:'join'}],squadsSnapshot:[{id:'g05_squad',name:'北境一队'}]});
 const rows=()=>f.db.prepare('SELECT collection,id,hash FROM json_records ORDER BY collection,id').all();const before=rows();
 const dryRun=migrateStats(f.db),applied=migrateStats(f.db,{dryRun:false}),replayed=migrateStats(f.db,{dryRun:false});assert.deepEqual(rows(),before);assert.equal(replayed.items[0].status,'reused');
 const projected=f.service.list(f.member(),{wipeId:'g07_history',sourceId:'vital',metricVersion:'nb-kda-1',revision:1});assert.equal(projected.items.length,1);
 await writeFile('output/test-results/g07-stats/migration.json',JSON.stringify({constructedOnly:true,dryRun,applied,replayed,sourceRecordsUnchanged:true,sourceRecordCount:before.length,projectedRows:projected.items.length,sqliteIntegrity:f.db.prepare('PRAGMA integrity_check').get()},null,2)+'\n');console.log('migration rehearsal passed');
}finally{f.db.close();}
