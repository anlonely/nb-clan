import { issueObservation } from './projection.js';
import { mooseCatalog } from '../management-adapters/source-host/moose-catalog.js';
import { withControlledPage } from './browser.js';
import { requireFact, digest, fault } from './transport.js';
import { waitForMooseHydration, waitForTableSettled, selectDropdown, waitForComboboxEnabled, dropdownOptions, combobox, innerText, selectCategory, searchPlayer, extractTable, exactPlayerMatch } from './moose-dom.js';
const clean = s => String(s || '').replace(/\s+/g,' ').trim();
const slug = s => clean(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
const period = (name,active=false) => ({id:slug(name),name,nameZh:name.toLowerCase()==='all time'?'全部时间':name,active});
/** Fits createSourceHost.mooseEngine(input,{signal,origin,request}); owned raw/WS transport is explicit construction, never the legacy global browser. */
export function createMooseEngine({ transport, executablePath }) {
  requireFact(transport?.open, 'SOURCE_NOT_CONFIGURED');
  const engine = async (original, options = {}) => {
    const input = structuredClone(original), inputBinding = digest(input), catalog = mooseCatalog(), server = catalog.servers.find(s=>s.id===input.serverId);
    requireFact(server && ['periods','player'].includes(input.kind));
    if(input.kind==='player') requireFact(/^7656119\d{10}$/.test(input.steamId) && typeof input.period==='string' && input.period.length>0 && input.period.length<=120 && (input.playerName===undefined || typeof input.playerName==='string'&&input.playerName.length<=120) && Array.isArray(input.categoryIds) && input.categoryIds.length<=12 && input.categoryIds.every(id=>id==='all'||catalog.categories.some(c=>c.id===id)));
    const selected = !input.categoryIds?.length || input.categoryIds.includes('all') ? catalog.categories : catalog.categories.filter(c=>input.categoryIds.includes(c.id));
    const session = transport.open('moose',{signal:options.signal,origin:options.origin});
    return withControlledPage({session,executablePath,task:async page=>{
      await page.goto(session.origin+'/stats',{waitUntil:'domcontentloaded',timeout:15000});
      await waitForMooseHydration(page); await waitForTableSettled(page); await selectDropdown(page,0,server.name); await waitForComboboxEnabled(page,1);
      const names = await dropdownOptions(page,1); requireFact(names.length>0 && names.length<=100 && names.every(n=>n.length<=120) && new Set(names).size===names.length,'SOURCE_PAGE_LIMIT');
      const activeName = clean(await innerText(await combobox(page,1)));
      if(input.kind==='periods') { session.check(); requireFact(digest(original)===inputBinding,'CREDENTIALS_CHANGED'); return {server,periods:names.map(n=>period(n,n===activeName)),categories:catalog.categories,evidence:session.evidence()}; }
      const requested = clean(input.period), resolved = names.find(n=>n.toLowerCase()===requested.toLowerCase() || slug(n)===requested);
      requireFact(resolved,'SOURCE_NO_MATCH'); await selectDropdown(page,1,resolved);
      const categories=[]; let identity=null;
      for(const category of selected){
        session.check(); await selectCategory(page,category); await searchPlayer(page,input.steamId);
        let table=await extractTable(page,category.id), matches=table.rows.filter(r=>r.steamId===input.steamId);
        requireFact(matches.length<=1); let match=exactPlayerMatch(table.rows,input.steamId);
        if(!match && clean(input.playerName)) {
          await searchPlayer(page,clean(input.playerName)); table=await extractTable(page,category.id);
          matches=table.rows.filter(r=>r.steamId===input.steamId); requireFact(matches.length<=1); match=exactPlayerMatch(table.rows,input.steamId);
        }
        if(match && !identity) identity={steamId:match.steamId,playerName:match.playerName,playerUrl:match.playerUrl,avatar:match.avatar};
        categories.push({category,fields:table.fields,selectedMatch:match,matches:match?[match]:[]});
      }
      requireFact(identity?.steamId===input.steamId,'SOURCE_NO_MATCH'); session.check(); requireFact(digest(original)===inputBinding,'CREDENTIALS_CHANGED');
      const result={source:session.origin+'/stats',server,period:period(resolved,true),identity,categories,matchedCategories:categories.filter(c=>c.selectedMatch).length,evidence:{...session.evidence(),steamId:input.steamId,serverId:input.serverId,period:resolved,categoryIds:selected.map(c=>c.id)}};
      requireFact(JSON.stringify(result).length<=250000,'SOURCE_RESPONSE_TOO_LARGE'); return issueObservation(result,{kind:'moose_player',context:{steamId:input.steamId,serverId:input.serverId,requestedPeriod:clean(input.period),categoryIds:selected.map(c=>c.id),binding:session.binding,revision:session.revision,maxAgeMs:300000},checkCurrent:()=>{requireFact(transport.binding('moose')===session.binding && digest(original)===inputBinding,'CREDENTIALS_CHANGED');}});
    }});
  };
  Object.defineProperty(engine,'requiresProviderProjection',{value:true});return engine;
}
