import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import {can,validGrant,scopeMatches,CAPABILITIES,MEMBER_GRANTS,grant} from '../server/v2/identity/permissions.js';

const previous=(actor,capability,resource,relations)=>{
  if(!actor||actor.status!=='active'||actor.restricted||!CAPABILITIES.includes(capability))return false;
  const grants=[...(actor.grants||[]),...(actor.memberId?MEMBER_GRANTS:[])];
  const matched=grants.filter(g=>validGrant(g)&&g.capability===capability&&scopeMatches(g.scope,actor,resource,relations,g.effect));
  return matched.some(g=>g.effect==='allow')&&!matched.some(g=>g.effect==='deny');
};
test('capability prefilter preserves malformed grants, deny, self and squad decisions',async()=>{
  const relations={squadMembers:[{memberId:'m',squadId:'s'}],wipes:[{id:'w',audience:{memberIds:['m'],squadIds:[]}}]};
  const base={id:'a',memberId:'m',status:'active',grants:CAPABILITIES.map(c=>grant(c,{type:'all'}))};
  let comparisons=0;
  for(const grants of [base.grants,[],[null,{},grant('bogus',{type:'all'}),{capability:'signups.read',scope:{type:'all'},effect:'invalid'}],
    [...base.grants,{capability:'signups.read',effect:'deny',scope:{type:'squads',ids:['s']}}]]){
    for(const actor of [{...base,grants},{...base,grants,status:'disabled'},{...base,grants,restricted:true},{...base,grants,memberId:null}]){
      for(const capability of [...CAPABILITIES,'bogus'])for(const resource of [{kind:'member',id:'m'},{kind:'signup',memberId:'m',wipeId:'w'},{kind:'signup',memberId:'other',wipeId:'w'},{kind:'wipe',id:'w'}]){
        assert.equal(can(actor,capability,resource,relations),previous(actor,capability,resource,relations));comparisons++;
      }
    }
  }
  const times={};for(const [name,fn]of [['previous',previous],['prefilter',can]]){const begin=performance.now();for(let n=0;n<20000;n++)fn(base,'signups.read',{kind:'signup',memberId:'m',wipeId:'w'},relations);times[name]=performance.now()-begin;}
  await fs.writeFile(new URL('../output/test-results/g08/permission-filter.json',import.meta.url),JSON.stringify({comparisons,iterations:20000,times,note:'CPU microcheck only, not HTTP acceptance'},null,2)+'\n');
});
