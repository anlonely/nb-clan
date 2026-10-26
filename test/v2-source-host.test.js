import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fixture as baseFixture } from './support/v2-source-adapters/fixture.mjs';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { createManagementSourceAdapters } from '../server/v2/management-adapters/sources/index.js';
import { SyncCenterService } from '../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';
const op = () => ({ operationId: randomUUID() });
const sid = '76561198000000501';
const scope = { kind: 'members', memberIds: ['g05_alpha'], wipeId: 'fixture-wipe' };
async function setup(t, changes = {}) {
  const base = await baseFixture(); await base.worker.stop();
  const calls = [], behavior = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path: url.pathname, url: req.url, headers: req.headers, method: req.method, body });
    if (behavior.has(url.pathname)) return behavior.get(url.pathname)(req, res, url, body);
    res.setHeader('content-type', 'application/json');
    const end = x => res.end(JSON.stringify(x));
    if (url.pathname.includes('GetPlayerSummaries')) return end({ response: { players: [{ steamid: url.searchParams.get('steamids'), personaname: 'Host HTTP Steam', avatarfull: 'https://avatars.steamstatic.com/example.jpg', communityvisibilitystate: 3, timecreated: 1577836800 }] } });
    if (url.pathname.includes('GetOwnedGames')) return end({ response: { games: [{ appid: 252490, playtime_forever: 0 }] } });
    if (url.pathname.includes('GetUserStatsForGame')) return end({ playerstats: { steamID: url.searchParams.get('steamid'), stats: [{ name: 'kill_player', value: 0 }, { name: 'deaths', value: 3 }, { name: 'harvest.sulfur_ore', value: 99 }] } });
    if (url.pathname.includes('ResolveVanityURL')) return end({ response: { success: 1, steamid: sid } });
    if (url.pathname.includes('GetPlayerBans')) return end({ players: [{ SteamId: url.searchParams.get('steamids'), VACBanned: false, NumberOfVACBans: 0 }] });
    if (url.pathname.startsWith('/inventory/')) return end({ success: 1, assets: [{ assetid: '1', classid: '2', instanceid: '0', amount: '2' }], descriptions: [{ classid: '2', instanceid: '0', market_hash_name: 'Test skin', tradable: 1, marketable: 1 }], more_items: 0 });
    if (url.pathname === '/api/appdetails') { const id = url.searchParams.get('appids'); return end({ [id]: { success: true, data: id === '252490' ? { dlc: [1409640] } : { name: 'Sunburn Pack', price_overview: { final: 999, currency: 'USD' } } } }); }
    if (url.pathname.includes('ajaxgetitemdefs')) return end({ total_count: 1, results_html: '<div class="item_def_name ellipsis"><a href="https://store.steampowered.com/itemstore/252490/detail/1/">Store skin</a></div><div class="item_def_price">$4.99</div>' });
    if (url.pathname === '/players/overview') return end({ data: body.playerIds.map(id => ({ context: { userId: id }, player: { name: 'Vital member' }, statistics: { combat: { kills: 0, deaths: 0 } } })) });
    if (url.pathname === '/servers') return end({ data: [{ id: '4', displayName: 'Vital source', battlemetricsServerId: '501' }] });
    if (url.pathname === '/servers/4/wipes') return end({ data: [{ id: 'period-1' }] });
    if (url.pathname === '/players/match') return end({ data: [{ type: 'identifier', attributes: { type: 'steamID', identifier: body.data[0].attributes.identifier }, relationships: { player: { data: { type: 'player', id: '501' } } } }] });
    if (url.pathname.endsWith('/relationships/sessions')) return end({ data: [] });
    if (url.pathname === '/stats') return end({ identity: { steamId: sid }, matchedCategories: 1, categories: [{ category: { id: 'pvp', name: 'PvP' }, fields: [{ id: 'kills', label: 'Kills' }], selectedMatch: { values: { kills: 5 } } }] });
    res.statusCode = 404; end({});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const settings = { steamWebApi: { apiKey: 'steam-host-secret-abcdef' }, battlemetrics: { apiKeys: [{ apiKey: 'bm-host-secret-abcdef' }] }, system: { proxy: {} } };
  const old = base.repo.get('schedulingWipes', 'fixture-wipe');
  base.put('v2Wipes', { ...old, serverActualWipeAt: new Date(Date.now() - 3600000).toISOString(), serverSnapshot: { kdaProvider: 'vital', vitalServerId: '4', vitalWipeId: 'period-1', battlemetricsId: '501' } });
  const cutoff = new Date().toISOString();
  const options = {
    readWindow: () => ({ to: cutoff }),
    readSettings: () => settings, readWipe: id => base.repo.get('schedulingWipes', id),
    sharedBattlemetricsQueue: base.queue, fetchImpl: fetch,
    allowLoopbackForTests: true, origins: Object.fromEntries(['steam','community','store','vital','battlemetrics','moose','scmm','rusthelp'].map(x => [x, origin])),
    capabilities: { steam: true, steamRisk: true, inventory: true, storeCatalog: true, dlcCatalog: true, vital: true, battlemetrics: true, hexaytron: true, moose: true },
    readHexCard: ({ steamId }) => ({ steamId, observedAt: new Date().toISOString(), message: { id: 'existing-card', embeds: [{ fields: [{ name: 'Rust', value: '12 hours' }] }] } }),
    mooseEngine: (input, { request }) => input.kind === 'periods' ? Promise.resolve({ periods: [{ name: 'This Wipe' }] }) : request('/stats'),
    ...changes
  };
  const host = createSourceHost(options);
  const sources = createManagementSourceAdapters({ ...base.options, ...host });
  const service = new SyncCenterService({ db: base.db, identity: base.identity, authority: sources.authority });
  const worker = createSyncCenterWorker(service, { providers: sources.providers });
  t.after(async () => { await worker.stop(); await host.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); await base.close(); });
  return { ...base, host, sources, service, worker, options, settings, calls, behavior, origin };
}
async function run(f, type) { const { job } = await f.service.request(f.actor(), { type, scope }, op()); await f.worker.step(); return f.service.detail(f.actor(), job.id); }

test('host composes real source factory and updates SQLite fields via Steam/BM/Vital HTTP reads', async t => {
  const f = await setup(t);
  for (const type of ['steam_profile_backfill','member_profile','battlemetrics_identity','battlemetrics_playtime','kda']) assert.equal((await run(f, type)).status, 'succeeded', type);
  const m = f.repo.get('members','g05_alpha'), p = f.sources.store.profile(m);
  assert.equal(m.steamNickname,'Host HTTP Steam'); assert.equal(p.playTimeMinutes,0); assert.equal(p.battlemetricsServerPlayTimeSeconds,0); assert.equal(p.hexaytron,undefined);
  assert.equal(m.avatar, 'https://avatars.steamstatic.com/example.jpg');
  assert.equal(m.steamAvatar, m.avatar);
  assert.equal(f.sources.store.statsRow('fixture-wipe',m.id).kills,0);
  assert.equal(f.queue.snapshot().limits.globalUsed,2); // Match and sessions, no nested queue.
  assert.equal(f.calls.find(x=>x.path==='/players/match').headers.authorization,'Bearer bm-host-secret-abcdef');
  const facts = JSON.stringify(f.db.prepare("SELECT payload FROM sync_center_records WHERE kind='job'").all());
  assert.ok(!facts.includes('host-secret')); assert.ok(!JSON.stringify(f.host).includes('host-secret'));
});
test('Steam avatar updates follow the source while preserving a custom member avatar', async t => {
  const f = await setup(t);
  assert.equal((await run(f, 'steam_profile_backfill')).status, 'succeeded');
  assert.equal(f.repo.get('members', 'g05_alpha').avatar, 'https://avatars.steamstatic.com/example.jpg');
  const updated = 'https://avatars.steamstatic.com/updated.jpg';
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/', (_req, res, url) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ response: { players: [{ steamid: url.searchParams.get('steamids'), personaname: 'Updated', avatarfull: updated, communityvisibilitystate: 3 }] } }));
  });
  assert.equal((await run(f, 'member_profile')).status, 'succeeded');
  const member = f.repo.get('members', 'g05_alpha');
  assert.equal(member.avatar, updated); assert.equal(member.steamAvatar, updated);
  f.put('members', { ...member, avatar: 'https://example.com/custom.jpg' });
  assert.equal((await run(f, 'member_profile')).status, 'succeeded');
  assert.equal(f.repo.get('members', 'g05_alpha').avatar, 'https://example.com/custom.jpg');
});

test('official/inventory/Vital/Moose/catalog providers preserve zero, unknown ownership and query-only facts', async t => {
  const f = await setup(t), options = { signal: new AbortController().signal };
  const before = f.db.prepare("SELECT group_concat(hash) h FROM json_records").get().h;
  const official = await f.sources.statsProviders.official({ steamInput: sid },options);
  assert.equal(official.rows[0].kills,0); assert.equal(official.rows[0].steamTotalSeconds,null); assert.equal(official.rows[0].assists,null);
  assert.equal(official.displayName,'Host HTTP Steam');assert.equal(official.steamProfile.createdAt,'2020-01-01T00:00:00.000Z');
  assert.equal(official.steamProfile.avatar,'https://avatars.steamstatic.com/example.jpg');
  const inventory = await f.sources.statsProviders.inventory({ steamInput:sid }, options);
  assert.equal(inventory.status,'partial'); assert.equal(inventory.inventory.total,null);
  assert.equal(inventory.displayName,'Host HTTP Steam');
  assert.equal(inventory.steamProfile.createdAt,'2020-01-01T00:00:00.000Z');
  assert.equal(inventory.steamProfile.playtimeMinutes,0);
  assert.equal(inventory.inventory.items.find(x=>x.category==='skins').quantity,2);
  assert.equal(inventory.inventory.items.find(x=>x.category==='dlc').quantity,null);
  assert.equal(inventory.inventory.items.some(x=>x.category==='store'),false);
  assert.equal(f.calls.some(x=>x.path==='/itemstore/252490/ajaxgetitemdefs/'),false);
  assert.equal((await f.sources.statsProviders.catalog({provider:'vital'},options)).items[0].id,'4');
  assert.equal((await f.sources.statsProviders.catalog({provider:'vital',serverId:'4'},options)).items[0].providerWipeId,'period-1');
  const moose = await f.sources.statsProviders.moose({steamInput:sid,serverId:'eu-main',providerWipeId:'This Wipe',categoryIds:['pvp']},options);
  assert.equal(moose.fields[0].value,5);
  assert.equal((await f.sources.statsProviders.catalog({provider:'moose'},options)).items.length,16);
  assert.equal(f.db.prepare("SELECT group_concat(hash) h FROM json_records").get().h,before);
  const risk = await f.host.readers.readSteamRisk(sid,options); assert.equal(risk.vacBanned,false); assert.equal(risk.numberOfVacBans,0); assert.equal(risk.communityBanned,null);
});
test('configuration is synchronous/read-only, freezes window, tracks canonical changes and never exposes secrets', async t => {
  const f = await setup(t); const input={type:'kda',scope,member:f.repo.get('members','g05_alpha')};
  const before=JSON.stringify(f.settings), a=f.host.readSourceConfig(input), b=f.host.readSourceConfig(input);
  assert.deepEqual(a,b);assert.equal(a.providerServerId,'4');assert.equal(a.serverId,'host-server');assert.equal(JSON.stringify(f.settings),before);
  const {job}=await f.service.request(f.actor(),{type:'kda',scope},op());
  const w=f.repo.get('schedulingWipes','fixture-wipe'); f.put('v2Wipes',{...w,serverSnapshot:{...w.serverSnapshot,vitalWipeId:'period-changed'}});
  await f.worker.step();assert.equal(f.service.detail(f.actor(),job.id).status,'failed');assert.equal(f.calls.length,0);
  const asyncHost=createSourceHost({...f.options,readSettings:async()=>f.settings});t.after(()=>asyncHost.stop());
  assert.throws(()=>asyncHost.readSourceConfig({type:'member_profile'}),{errorCode:'SOURCE_CONFIG_SYNC_REQUIRED'});
});
test('stop cancels and drains owned HTTP while leaving the shared BM queue usable', async t => {
  const f=await setup(t);let entered=false;
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/',()=>{entered=true;});
  const pending=f.host.readers.steamProfile({member:{steamId:sid},signal:new AbortController().signal});
  const rejected=assert.rejects(pending,{errorCode:'SOURCE_TIMEOUT'});while(!entered)await new Promise(r=>setImmediate(r));
  await f.host.stop();await rejected;assert.equal(f.host.activeIO,0);
  assert.equal(await f.queue.enqueue({run:()=>42}),42);
  await assert.rejects(f.host.readers.stats.official(sid),{errorCode:'SOURCE_TIMEOUT'});
});
test('explicit caller signal cancels the host vanity reader (root provider forwarding prerequisite)', async t => {
  const f=await setup(t);let entered=false;f.behavior.set('/ISteamUser/ResolveVanityURL/v0001/',()=>{entered=true;});
  const c=new AbortController();const pending=f.host.readers.stats.resolveVanity('test-vanity', {signal:c.signal});
  const rejected=assert.rejects(pending,{errorCode:'SOURCE_TIMEOUT'});while(!entered)await new Promise(r=>setImmediate(r));c.abort();await rejected;
  await f.host.stop();assert.equal(f.host.activeIO,0);
});
test('429 and credentials failures remain safe; no HTTP response/error/key leakage',async t=>{
  const f=await setup(t);
  f.behavior.set('/players/match',(_q,r)=>{r.statusCode=429;r.setHeader('retry-after','2');r.end('bm-host-secret-abcdef');});
  const d=await run(f,'battlemetrics_identity');assert.equal(d.status,'retry_wait');assert.equal(d.items[0].reason,'RATE_LIMITED');assert.ok(f.queue.snapshot().limits.rateLimitedUntil);
  assert.ok(!JSON.stringify(d).includes('host-secret'));
  f.behavior.set('/ISteamUserStats/GetUserStatsForGame/v0002/',(_q,r)=>{r.statusCode=403;r.end('steam-host-secret-abcdef');});
  await assert.rejects(f.host.readers.stats.official(sid),e=>e.errorCode==='CREDENTIALS_INVALID'&&!String(e).includes('host-secret'));
});
test('inventory query keeps observed items when optional DLC or valuation sources are rate limited',async t=>{
  const f=await setup(t,{capabilities:{steam:true,inventory:true,dlcCatalog:true,inventoryEnrichment:true},
    inventoryEnrichment:async({steamId},{request})=>request('scmm',`/api/inventory/${steamId}/value`)});
  f.behavior.set(`/api/inventory/${sid}/value`,(_q,r)=>r.end(JSON.stringify({prices:[],entitlements:[]})));
  f.behavior.set('/api/appdetails',(_q,r)=>{r.statusCode=429;r.setHeader('retry-after','2');r.end('{}');});
  let result=await f.sources.statsProviders.inventory({steamInput:sid});
  assert.equal(result.status,'partial');assert.equal(result.inventory.items[0].name,'Test skin');
  assert.deepEqual(result.errors.map(e=>[e.sourceId,e.errorCode]),[['store','RATE_LIMITED']]);
  assert.equal(result.errors[0].retryAfterMs,2000);assert.equal(result.errors[0].retryAfterKnown,true);
  f.behavior.delete('/api/appdetails');
  f.behavior.set(`/api/inventory/${sid}/value`,(_q,r)=>{r.statusCode=429;r.setHeader('retry-after','3');r.end('{}');});
  result=await f.sources.statsProviders.inventory({steamInput:sid});
  assert.equal(result.status,'partial');assert.equal(result.inventory.items.some(x=>x.dlc),true);
  assert.deepEqual(result.errors.map(e=>[e.sourceId,e.errorCode]),[['scmm','RATE_LIMITED']]);
  assert.equal(result.errors[0].retryAfterMs,3000);assert.equal(result.errors[0].retryAfterKnown,true);
  f.behavior.set(`/inventory/${sid}/252490/2`,(_q,r)=>{r.statusCode=429;r.setHeader('retry-after','4');r.end('{}');});
  result=await f.sources.statsProviders.inventory({steamInput:sid});
  assert.equal(result.status,'partial');assert.equal(result.inventory.status,'unavailable');
  assert.equal(result.inventory.total,null);assert.deepEqual(result.inventory.items,[]);
  assert.equal(result.displayName,'Host HTTP Steam');assert.equal(result.steamProfile.playtimeMinutes,0);
  assert.deepEqual(result.errors.map(e=>[e.sourceId,e.errorCode,e.retryAfterKnown]),[['community','RATE_LIMITED',true]]);
  // A fresh source owner has no previous known cooldown to reuse.
  const unknown=await setup(t,{capabilities:{steam:true,inventory:true}});
  unknown.behavior.set(`/inventory/${sid}/252490/2`,(_q,r)=>{r.statusCode=429;r.end('{}');});
  result=await unknown.sources.statsProviders.inventory({steamInput:sid});
  assert.deepEqual(result.errors.map(e=>[e.sourceId,e.errorCode,e.retryAfterKnown]),[['community','RATE_LIMITED',false]]);
  await assert.rejects(unknown.host.readers.stats.inventory(sid),e=>e.errorCode==='RATE_LIMITED'&&e.sourceId==='community'&&e.retryAfterKnown===false);
});
test('Steam official stats 400 means this account has no published stats',async t=>{
  const f=await setup(t);
  f.behavior.set('/ISteamUserStats/GetUserStatsForGame/v0002/',(_q,r)=>{r.statusCode=400;r.end('{}');});
  await assert.rejects(f.host.readers.stats.official(sid),{errorCode:'SOURCE_NO_MATCH'});
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/',(_q,r)=>{r.statusCode=400;r.end('{}');});
  await assert.rejects(f.host.readers.stats.summary(sid),{errorCode:'SOURCE_UNAVAILABLE'});
});
test('optional Steam profile failure does not hide official stats or claim conflicting zero hours',async t=>{
  const f=await setup(t);
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/',(_q,r)=>{r.statusCode=503;r.end('{}');});
  const result=await f.sources.statsProviders.official({steamInput:sid});
  assert.equal(result.rows[0].kills,0);assert.equal(result.rows[0].steamTotalSeconds,null);
  assert.equal(result.steamProfile,null);
});
test('public Rust showcase hours replace a conflicting zero from GetOwnedGames',async t=>{
  const f=await setup(t);
  f.behavior.set(`/profiles/${sid}/`,(_q,r)=>{
    r.setHeader('content-type','text/html');
    r.end('<div class="favoritegame_showcase"><a href="https://steamcommunity.com/app/252490">Rust</a><div class="showcase_stats_row"><div class="value">10,817</div><div class="label">Hours played</div></div></div>');
  });
  const result=await f.sources.statsProviders.official({steamInput:sid});
  assert.equal(result.rows[0].steamTotalSeconds,10817*3600);
  const request=f.calls.find(x=>x.path===`/profiles/${sid}/`);
  assert.ok(request);assert.equal(request.headers.accept,'text/html');assert.equal(request.url.includes('key='),false);
});
test('an actual zero-hour Rust account keeps zero when official activity is also zero',async t=>{
  const f=await setup(t);
  f.behavior.set('/ISteamUserStats/GetUserStatsForGame/v0002/',(_q,r,url)=>{
    r.setHeader('content-type','application/json');
    r.end(JSON.stringify({playerstats:{steamID:url.searchParams.get('steamid'),stats:[{name:'kill_player',value:0},{name:'deaths',value:0}]}}));
  });
  const result=await f.sources.statsProviders.official({steamInput:sid});
  assert.equal(result.rows[0].steamTotalSeconds,0);
});
test('redirects, foreign pagination and untrusted paths are rejected without following',async t=>{
  const f=await setup(t);
  f.behavior.set('/ISteamUserStats/GetUserStatsForGame/v0002/',(_q,r)=>{r.statusCode=302;r.setHeader('location','https://attacker.invalid/steal');r.end();});
  await assert.rejects(f.host.readers.stats.official(sid),{errorCode:'SOURCE_REDIRECT_REJECTED'});
  assert.equal(f.calls.length,1);
  await assert.rejects(Promise.resolve().then(()=>f.host.readers.battlemetricsGet('//attacker.invalid/players')),{errorCode:'SOURCE_URL_REJECTED'});
  await run(f,'battlemetrics_identity');
  f.behavior.set('/players/501/relationships/sessions',(_q,r)=>r.end(JSON.stringify({data:[],links:{next:'https://attacker.invalid/sessions'}})));
  assert.equal((await run(f,'battlemetrics_playtime')).status,'failed');
  f.behavior.set(`/inventory/${sid}/252490/2`,(_q,r)=>r.end(JSON.stringify({success:1,assets:[],descriptions:[],more_items:1,last_assetid:'1'})));
  await assert.rejects(f.host.readers.stats.inventory(sid),{errorCode:'SOURCE_PAGINATION_INVALID'});
});
test('missing capabilities, proxy implementation or safe Moose engine fail closed',async t=>{
  const f=await setup(t);
  const noMoose=createSourceHost({...f.options,mooseEngine:undefined});t.after(()=>noMoose.stop());
  await assert.rejects(noMoose.readers.stats.moose({steamId:sid,serverId:'eu-main',period:'This Wipe',categoryIds:[]}),{errorCode:'SOURCE_NOT_CONFIGURED'});
  f.settings.system.proxy={url:'http://proxy-user:proxy-secret@127.0.0.1:9',scope:'kda'};
  await assert.rejects(f.host.readers.stats.official(sid),e=>e.errorCode==='PROXY_UNAVAILABLE'&&!String(e).includes('proxy-secret'));
  const disabled=createSourceHost({...f.options,capabilities:{}});t.after(()=>disabled.stop());
  assert.equal(disabled.readSourceConfig({type:'kda',scope}).enabled,false);
  await assert.rejects(disabled.readers.stats.official(sid),{errorCode:'SOURCE_NOT_CONFIGURED'});
});

test('trusted proxy injection maps store scope and explicit credential fallback without exposing either', async t => {
  const seen=[];
  const f=await setup(t,{readCredentials:()=>({steamApiKey:'fallback-steam-secret',battlemetricsApiKey:'override-bm-secret'}),proxyFetch:(url,options)=>{seen.push({url,proxy:options.proxyUrl,auth:options.headers.authorization});const {proxyUrl,...safe}=options;return fetch(url,safe);}});
  f.settings.system.proxy={url:'socks5://user:proxy-password@localhost:9999',scope:'global'};
  await f.host.readers.stats.official(sid);
  assert.ok(seen[0].url.includes('steam-host-secret')); // Stored Steam key beats explicitly injected env fallback.
  await f.host.readers.battlemetricsGet('/players/match',{method:'POST',body:{data:[{type:'identifier',attributes:{type:'steamID',identifier:sid}}]}});
  assert.equal(seen.at(-1).auth,'Bearer override-bm-secret');
  assert.ok(seen.every(x=>x.proxy.includes('proxy-password')));
  const config=f.host.readSourceConfig({type:'battlemetrics_playtime',scope});assert.ok(!JSON.stringify(config).includes('password'));assert.ok(!JSON.stringify(config).includes('secret'));
});
test('all successful response strings are scrubbed; oversized and delayed body streams are bounded/cancelled',async t=>{
  const f=await setup(t,{maxBytes:512,timeoutMs:60});
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/',(_q,r,url)=>r.end(JSON.stringify({response:{players:[{steamid:url.searchParams.get('steamids'),personaname:'steam-host-secret-abcdef',avatarfull:''}]}})));
  const summary=await f.host.readers.stats.summary(sid);assert.equal(summary.name,'[redacted]');
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/',(_q,r)=>r.end(JSON.stringify({x:'a'.repeat(1000)})));
  await assert.rejects(f.host.readers.stats.summary(sid),{errorCode:'SOURCE_RESPONSE_TOO_LARGE'});
  let ended=false;
  f.behavior.set('/ISteamUser/GetPlayerSummaries/v0002/',(_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.write('{');r.on('close',()=>ended=true);});
  await assert.rejects(f.host.readers.stats.summary(sid),{errorCode:'SOURCE_TIMEOUT'});
  await f.host.stop();assert.equal(f.host.activeIO,0);
  for(let i=0;i<100&&!ended;i++)await new Promise(r=>setImmediate(r));assert.equal(ended,true);
});
test('Moose managed engine abort drains its scope and never revives a stopped source host',async t=>{
  let entered=false,closed=false;
  const f=await setup(t,{mooseEngine:(_input,{signal})=>new Promise((_resolve,reject)=>{entered=true;signal.addEventListener('abort',()=>{closed=true;reject(new Error('browser upstream secret'));},{once:true});})});
  const pending=f.host.readers.stats.moose({steamId:sid,serverId:'eu-main',period:'This Wipe',categoryIds:['pvp']});
  const rejected=assert.rejects(pending,{errorCode:'SOURCE_TIMEOUT'});while(!entered)await new Promise(r=>setImmediate(r));
  await f.host.stop();await rejected;assert.equal(closed,true);assert.equal(f.host.activeIO,0);
});
test('restart reuses task-frozen window and manual/none KDA never selects official lifetime as a wipe source',async t=>{
  const f=await setup(t);const m=f.repo.get('members','g05_alpha');
  const frozen=f.host.readSourceConfig({type:'battlemetrics_playtime',scope,member:m});
  const host=createSourceHost({...f.options,readWindow:()=>({from:frozen.from,to:frozen.to})});t.after(()=>host.stop());
  assert.equal(host.readSourceConfig({type:'battlemetrics_playtime',scope:{...scope,sourceContexts:{[m.id]:frozen}},member:m}).to,frozen.to);
  const w=f.repo.get('schedulingWipes','fixture-wipe');f.put('v2Wipes',{...w,serverSnapshot:{...w.serverSnapshot,kdaProvider:'manual'}});
  assert.equal(host.readSourceConfig({type:'kda',scope}).enabled,false);
  assert.equal(host.readSourceConfig({type:'kda',scope}).sourceId,'manual');
});

test('inventory enrichment runs through bounded managed HTTP and keeps entitlement evidence distinct from skin names',async t=>{
  const f=await setup(t,{capabilities:{steam:true,inventory:true,dlcCatalog:true,inventoryEnrichment:true},inventoryEnrichment:async({steamId},{request})=>request('scmm',`/api/inventory/${steamId}/value`)});
  f.behavior.set(`/api/inventory/${sid}/value`,(_q,r)=>r.end(JSON.stringify({prices:[{id:'1',price:3,currency:'USD'}],entitlements:[{appid:1409640,owned:true,evidenceId:'controlled-license-proof'}]})));
  const inventory=await f.host.readers.stats.inventory(sid,{signal:new AbortController().signal});
  assert.equal(inventory.totalSummary.totalValue,6);assert.equal(inventory.dlcs[0].owned,true);assert.equal(inventory.dlcOwnershipAvailable,true);
  assert.equal(f.host.activeIO,0);
});
test('private inventory preserves unknown instead of false zero; absent stable active window disables only BM playtime',async t=>{
  const f=await setup(t,{readWindow:undefined});
  assert.equal(f.host.readSourceConfig({type:'battlemetrics_playtime',scope}).enabled,false);
  assert.equal(f.host.readSourceConfig({type:'battlemetrics_identity',scope}).enabled,true);
  f.behavior.set(`/inventory/${sid}/252490/2`,(_q,r)=>{r.statusCode=403;r.end('{}');});
  const result=await f.host.readers.stats.inventory(sid);assert.equal(result.inventoryAvailable,false);assert.equal(result.totalSummary.totalValue,null);assert.equal(result.dlcs[0].owned,null);
});

test('trusted SQLite window intents advance independently and reject tampered or missing recovery windows', async t => {
  const f=await setup(t); const member=f.repo.get('members','g05_alpha');
  f.db.exec('CREATE TABLE test_collection_intents(id TEXT PRIMARY KEY, from_at TEXT, to_at TEXT)');
  const from=f.repo.get('schedulingWipes','fixture-wipe').serverActualWipeAt, firstTo=new Date().toISOString(), secondTo=new Date(Date.now()+60000).toISOString();
  f.db.prepare('INSERT INTO test_collection_intents VALUES(?,?,?)').run('first',from,firstTo);
  f.db.prepare('INSERT INTO test_collection_intents VALUES(?,?,?)').run('second',from,secondTo);
  let selected='first';
  // Intent selection is host state, never a client-provided query field.
  const host=createSourceHost({...f.options,readWindow:()=>{const r=f.db.prepare('SELECT from_at,to_at FROM test_collection_intents WHERE id=?').get(selected);return r?{from:r.from_at,to:r.to_at}:null;}});t.after(()=>host.stop());
  const input={type:'battlemetrics_playtime',scope,member};
  const a=host.readSourceConfig(input);assert.deepEqual(host.readSourceConfig(input),a);
  selected='second';const b=host.readSourceConfig(input);assert.notEqual(a.to,b.to);assert.equal(b.to,secondTo);
  assert.throws(()=>host.readSourceConfig({...input,scope:{...scope,sourceContexts:{[member.id]:{...b,to:'2099-01-01T00:00:00.000Z'}}}}),{errorCode:'SOURCE_WINDOW_INVALID'});
  selected='missing';assert.equal(host.readSourceConfig(input).unavailableReason,'SOURCE_WINDOW_REQUIRED');
  assert.throws(()=>host.readSourceConfig({...input,scope:{...scope,sourceContexts:{[member.id]:a}}}),{errorCode:'SOURCE_WINDOW_INVALID'});
});

test('optional game-detail failure preserves summary writeback and official KD while missing playtime stays unknown',async t=>{
  const f=await setup(t);
  f.behavior.set('/IPlayerService/GetOwnedGames/v0001/',(_req,res)=>{res.statusCode=503;res.end('{}');});
  const job=await run(f,'member_profile');assert.equal(job.status,'succeeded');
  const member=f.repo.get('members','g05_alpha'),profile=f.sources.store.profile(member);
  assert.equal(member.steamNickname,'Host HTTP Steam');assert.equal(profile.playTimeMinutes,undefined);assert.equal(profile.playTimeKnown,undefined);
  const raw=await f.sources.statsProviders.official({steamInput:sid},{signal:new AbortController().signal});
  const { projectQuery }=await import('../server/v2/stats/service.js');const result=projectQuery(raw,'official',Date.now());
  assert.equal(result.rows[0].values.kills,0);assert.equal(result.rows[0].values.deaths,3);
  assert.equal(result.rows[0].values.kd,0);assert.equal(result.rows[0].values.kda,null);assert.equal(result.rows[0].values.assists,null);
  assert.equal(result.rows[0].values.steamTotalSeconds,null);assert.equal(result.rows[0].reasons.kda,'assists_unsupported');
});
test('optional Steam request cannot swallow cancellation or credential-change fences',async t=>{
  const f=await setup(t);let entered;
  const reached=new Promise(resolve=>{entered=resolve;});
  f.behavior.set('/IPlayerService/GetOwnedGames/v0001/',()=>entered());
  const c=new AbortController(),pending=f.host.readers.steamProfile({member:{steamId:sid},signal:c.signal});
  const rejected=assert.rejects(pending,{errorCode:'SOURCE_TIMEOUT'});await reached;c.abort();await rejected;
  const { createSteamReaders }=await import('../server/v2/management-adapters/source-host/steam.js');
  const readers=createSteamReaders({allowed:()=>true,network:{json:async(_source,path)=>{
    if(path.includes('GetPlayerSummaries'))return {response:{players:[{steamid:sid,personaname:'Known'}]}};
    throw Object.assign(new Error('credential drift'),{errorCode:'CREDENTIALS_CHANGED'});
  }}});
  await assert.rejects(readers.summary(sid),{errorCode:'CREDENTIALS_CHANGED'});
});
test('failed configured proxy route is classified and persisted without leaking its URL or Steam key',async t=>{
  const f=await setup(t,{proxyFetch:async()=>{throw new Error('connect ECONNREFUSED socks5h://user:password@127.0.0.1:1080 key=steam-host-secret-abcdef');}});
  f.settings.system.proxy={url:'socks5h://user:password@127.0.0.1:1080',scope:'global'};
  const job=await run(f,'member_profile');assert.equal(job.status,'paused');assert.equal(job.items[0].reason,'PROXY_UNAVAILABLE');
  assert.equal(f.service.sourceStatus('steam').pauseReason,'PROXY_UNAVAILABLE');
  assert.ok(!JSON.stringify(job).includes('password'));assert.ok(!JSON.stringify(job).includes('host-secret'));
  assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')),null);
});
test('real risk host collection stores KD, unknown KDA and incomplete source evidence without reporting success',async t=>{
  const f=await setup(t,{capabilities:{steam:true,steamRisk:true,memberRisk:true,inventory:true}});
  f.behavior.set('/IPlayerService/GetOwnedGames/v0001/',(_req,res)=>res.end(JSON.stringify({response:{games:[{appid:252490,playtime_forever:120}]}}))); // Positive observation is required; zero alone may be hidden playtime.
  f.settings.accountRisk={rules:[{id:'restriction',type:'account_restricted',enabled:false},{id:'bans',type:'steam_ban_or_restriction',enabled:false},{id:'kd',type:'kd',enabled:true}]};
  let job=await run(f,'member_profile');assert.equal(job.status,'succeeded',JSON.stringify(job));
  let profile=f.sources.store.profile(f.repo.get('members','g05_alpha'));
  assert.equal(profile.officialKda.kd,0);assert.equal(profile.officialKda.kda,null);assert.equal(profile.officialKda.assists,null);assert.equal(profile.officialKda.source,'steam');
  assert.equal(profile.riskScan.fields['officialKda.kd'].status,'observed');
  const observedAt=profile.riskScan.fields['officialKda.kd'].observedAt,lastCompleteAt=profile.riskScan.lastCompleteAt,fetchedAt=profile.fetchedAt;
  f.behavior.set('/ISteamUserStats/GetUserStatsForGame/v0002/',(_q,res)=>{res.statusCode=500;res.end('{}');});
  job=await run(f,'member_profile');assert.equal(job.status,'partial');assert.equal(job.counts.partial,1);assert.equal(job.items[0].quality,'partial');assert.equal(job.items[0].reason,'RISK_SCAN_INCOMPLETE');
  assert.deepEqual(job.items[0].sourceResults.find(s=>s.source==='official'),{source:'official',status:'unavailable',error:'SOURCE_UNAVAILABLE',required:true,observedCount:0});
  assert.ok(job.items[0].sourceResults.every(s=>Object.keys(s).every(k=>['source','status','error','required','observedCount'].includes(k))));
  profile=f.sources.store.profile(f.repo.get('members','g05_alpha'));
  assert.equal(profile.officialKda.kd,0);assert.equal(profile.riskScan.fields['officialKda.kd'].retained,true);
  assert.equal(profile.riskScan.fields['officialKda.kd'].observedAt,observedAt);assert.equal(profile.officialKda.kda,null);
  assert.equal(profile.riskScan.sources.official.status,'unavailable');assert.equal(profile.riskScan.lastCompleteAt,lastCompleteAt);assert.equal(profile.fetchedAt,fetchedAt);
});
