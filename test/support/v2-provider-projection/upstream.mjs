import '../v2-source-main/offline.mjs';
import { createServer } from 'node:http';
import * as WebSocketModule from 'ws';
const WebSocketServer = WebSocketModule.WebSocketServer || WebSocketModule.default.Server;
export const sid='76561198000000501', other='76561198000000509';
export async function upstream() {
  const calls=[], sockets=new Set(); let mode='ok', release, releaseSocket;
  const server=createServer(async(req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1'),chunks=[];for await(const c of req)chunks.push(c);
    calls.push({path:u.pathname,method:req.method,query:Object.fromEntries(u.searchParams),headers:{currency:req.headers.currency,currencyCode:req.headers['x-currency-code'],authorization:req.headers.authorization,cookie:req.headers.cookie},bytes:Buffer.concat(chunks).length,...(u.pathname==='/_blazor'?{bodyHex:Buffer.concat(chunks).toString('hex')}:{})});
    const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    if(mode==='hold' && (/^\/api\/inventory\/\d+$/.test(u.pathname)||u.pathname==='/stats')){release=()=>json({});return;}
    if(mode==='redirect' && (u.pathname.includes('/inventory/')||u.pathname==='/stats')){res.writeHead(302,{location:'http://127.0.0.1:9/forbidden'});res.end();return;}
    if(mode==='rate' && (u.pathname.includes('/inventory/')||u.pathname==='/stats')){res.writeHead(429,{'retry-after':'2'});res.end();return;}
    if(mode==='big' && (/^\/api\/inventory\/\d+$/.test(u.pathname)||u.pathname==='/stats')){res.end('x'.repeat(3000000));return;}
    if(mode==='price429' && u.pathname.startsWith('/api/inventory/')){res.writeHead(429,{'retry-after':'2'});res.end();return;}
    if(mode==='private' && u.pathname.startsWith('/inventory/')){json({success:0,error:'This profile is private.'});return;}
    if(mode==='maxInventory'&&u.pathname.startsWith('/inventory/')){const from=Number(u.searchParams.get('start_assetid')||0),ids=Array.from({length:100},(_,i)=>from+i+1);json({success:1,assets:ids.map(id=>({assetid:String(id),classid:String(id),instanceid:'0',amount:'1'})),descriptions:ids.map(id=>({classid:String(id),instanceid:'0',market_hash_name:'Skin '+id,tradable:1})),more_items:from+100<2000,last_assetid:String(from+100)});return;}
    if(mode==='maxInventory'&&/^\/api\/inventory\/\d+$/.test(u.pathname)){const page=Number(u.searchParams.get('page')||1),pageSize=Number(u.searchParams.get('pageSize')||500);json({steamId:sid,currency:'USD',page,pageSize,total:2000,hasMore:page*pageSize<2000,items:Array.from({length:pageSize},(_,i)=>({name:'Skin '+((page-1)*pageSize+i+1),marketPrice:100,quantity:1}))});return;}
    if(mode==='maxInventory'&&u.pathname.endsWith('/value')){json({steamId:sid,currency:'USD',itemCount:2000,totalValue:200000});return;}
    if(u.pathname==='/stats') {res.writeHead(200,{'content-type':'text/html'});res.end(html(mode));return;}
    if(u.pathname==='/_blazor' && req.method==='POST'){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(Buffer.concat(chunks));return;}
    if(u.pathname==='/_blazor/negotiate') {json({negotiateVersion:1,connectionId:'fixture-id',connectionToken:'fixture-token',availableTransports:[{transport:'WebSockets',transferFormats:['Text','Binary']}]});return;}
    if(u.pathname.startsWith('/api/inventory/')&&u.pathname.endsWith('/summary')){json({steamId:mode==='identity'?other:u.pathname.split('/')[3],lastUpdatedInventoryOn:new Date().toISOString()});return;}
    if(u.pathname.startsWith('/api/inventory/')&&/^\/api\/inventory\/\d+$/.test(u.pathname)){
      const id=u.pathname.split('/')[3];json({steamId:mode==='identity'?other:id,...(mode==='currency'?{}:{currency:'USD'}),page:Number(u.searchParams.get('page')||1),pageSize:Number(u.searchParams.get('pageSize')||500),total:2,hasMore:false,items:[{id:'scmm-1',name:'Fixture Skin',marketPrice:mode.startsWith('aggregate')?null:mode==='partial'?null:mode==='zero'?0:250,quantity:2},{id:'scmm-2',name:'Sunburn Inner Tube',marketPrice:mode.startsWith('aggregate')?null:100,quantity:1}]});return;
    }
    if(u.pathname.startsWith('/api/inventory/')&&u.pathname.endsWith('/value')){json(mode==='partial'||mode.startsWith('aggregate')?{}:{steamId:u.pathname.split('/')[3],currency:'USD',totalValue:600,itemCount:3});return;}
    if(u.pathname.startsWith('/v1/inventory/summary/')){json({data:{steamId:mode==='aggregateWrongId'?other:u.pathname.split('/').at(-1),currency:mode==='aggregateCurrency'?'EUR':'USD',totalValue:mode==='aggregateZero'?0:8,totalItems:mode==='aggregateWrongCount'?2:3,...(mode==='aggregateExpired'?{observedAt:new Date(Date.now()-3600000).toISOString()}:{}),...(mode==='aggregateFuture'?{observedAt:new Date(Date.now()+3600000).toISOString()}:{}),rawSecret:'SHOULD_NOT_REACH_DTO'}});return;}
    if(u.pathname.startsWith('/inventory/')){json({success:1,assets:[{assetid:'1',classid:'2',instanceid:'0',amount:'2'},{assetid:'3',classid:'4',instanceid:'0',amount:'1'}],descriptions:[{classid:'2',instanceid:'0',name:'Fixture Skin',market_hash_name:'Fixture Skin',tradable:1,marketable:1},{classid:'4',instanceid:'0',name:'Sunburn Inner Tube',market_hash_name:'Sunburn Inner Tube',market_fee_app:1409640,tradable:1,marketable:1}],more_items:0});return;}
    if(u.pathname==='/broadcast/getbroadcastmpd/'){json({success:'ready',retry:0,eresult:1});return;}
    if(u.pathname.includes('GetPlayerBans')){json({players:[{SteamId:u.searchParams.get('steamids'),VACBanned:false,CommunityBanned:false,NumberOfVACBans:0,NumberOfGameBans:0,DaysSinceLastBan:0,EconomyBan:'none'}]});return;}
    if(u.pathname.includes('GetPlayerSummaries')){json({response:{players:[{steamid:u.searchParams.get('steamids'),personaname:'Provider fixture',communityvisibilitystate:3}]}});return;}
    if(u.pathname.includes('GetOwnedGames')){json({response:{games:[{appid:252490,playtime_forever:120}]}});return;}
    if(u.pathname==='/api/appdetails'){const id=u.searchParams.get('appids');json({[id]:{success:true,data:id==='252490'?{dlc:[1409640]}:{name:'Sunburn Pack',price_overview:{currency:'USD',final:999}}}});return;}
    json({},404);
  });
  const ws=new WebSocketServer({noServer:true});let wsConnections=0, binaryFrames=0, textFrames=0;
  server.on('upgrade',(req,socket,head)=>{if(!req.url.startsWith('/_blazor?')){socket.destroy();return;}
    if(mode==='wsRate'){socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n');return;}
    if(mode==='wsRedirect'){socket.end('HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:9/forbidden\r\nContent-Length: 0\r\n\r\n');return;}
    ws.handleUpgrade(req,socket,head,s=>ws.emit('connection',s,req));});
  ws.on('connection',socket=>{wsConnections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('message',(data,binary)=>{
    if(binary){binaryFrames++;socket.send(data,{binary:true});return;}
    textFrames++;
    for(const frame of data.toString().split('\x1e').filter(Boolean)){
      const x=JSON.parse(frame);if(x.protocol){socket.send('{}\x1e');continue;}
      const q=x.arguments[0];const result={steamId:mode==='wrongPlayer'?other:mode==='nameOnly'?(q.steamId==='Fixture Player'?sid:other):q.steamId||other,name:'Fixture Player',values:q.category==='resources'?['120','30']:['12','4']};
      const send=()=>socket.send(JSON.stringify({type:3,invocationId:x.invocationId,result})+'\x1e');
      if(mode==='holdWS'){releaseSocket=send;return;} if(mode==='bigWS'){socket.send(Buffer.alloc(300000),{binary:true});return;} send();
    }
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {origin:`http://127.0.0.1:${server.address().port}`,calls,get mode(){return mode;},set mode(v){mode=v;},get stats(){return {wsConnections,binaryFrames,textFrames,activeSockets:sockets.size};}, release:()=>release?.(), releaseSocket:()=>releaseSocket?.(),async close(){for(const s of sockets)s.terminate();await new Promise(r=>ws.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
function html(mode){return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif} [role=combobox]{display:block;padding:8px;width:240px} [role=option]{padding:6px} [role=tab]{display:inline-block;padding:8px}table,td,th{border:1px solid;padding:5px}</style></head><body>
<div role="combobox" aria-controls="servers" id="server">EU Mondays</div><div id="servers" hidden>${['EU Mondays','EU Medium','EU Main','EU Monthly'].map(x=>`<div role="option">${x}</div>`).join('')}</div>
<div role="combobox" aria-controls="periods" id="period">All Time</div><div id="periods" hidden><div role="option">All Time</div><div role="option">September 2026</div></div>
<div role="tab" aria-selected="true">PvP</div><div role="tab" aria-selected="false">Resources</div><input placeholder="Search..."><div id="table"></div>
<script>
(async()=>{
const tables=document.getElementById('table'),input=document.querySelector('input'),boxes=[...document.querySelectorAll('[role=combobox]')];let cat='pvp',sequence=0;const jobs=new Map();
const draw=result=>{tables.innerHTML='<table><thead><tr><th>Player</th><th>'+(cat==='pvp'?'Kills':'Wood')+'</th><th>'+(cat==='pvp'?'Deaths':'Stone')+'</th></tr></thead><tbody><tr><td><a href="https://steamcommunity.com/profiles/'+result.steamId+'">Fixture Player</a></td>'+result.values.map(v=>'<td>'+v+'</td>').join('')+'</tr></tbody></table>';};
draw({steamId:'${other}',values:['1','1']});
const negotiate=await fetch('/_blazor/negotiate?negotiateVersion=1',{method:'POST'}).then(r=>r.json());
const echo=await fetch('/_blazor?id=fixture-http&transport=LongPolling',{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array([0,255,128,42])}).then(r=>r.arrayBuffer());if([...new Uint8Array(echo)].join(',')!=='0,255,128,42')throw new Error('Binary HTTP corrupted');
const socket=new WebSocket(location.origin.replace('http','ws')+'/_blazor?id='+negotiate.connectionToken);socket.binaryType='arraybuffer';
await new Promise((resolve,reject)=>{socket.onopen=()=>{socket.send(JSON.stringify({protocol:'json',version:1})+'\\x1e');socket.send(new Uint8Array([0,255,128,42]));resolve();};socket.onerror=reject;});
socket.onmessage=e=>{if(typeof e.data!=='string')return;for(const frame of e.data.split('\\x1e').filter(Boolean)){const m=JSON.parse(frame);if(m.type===3){draw(m.result);jobs.get(m.invocationId)?.();jobs.delete(m.invocationId);}}};
const query=()=>new Promise(resolve=>{const id=String(++sequence);jobs.set(id,resolve);socket.send(JSON.stringify({type:1,invocationId:id,target:'Query',arguments:[{server:boxes[0].innerText,period:boxes[1].innerText,category:cat,steamId:input.value}]})+'\\x1e');});
boxes.forEach(box=>{box.setAttribute('_bl_fixture','');const list=document.getElementById(box.getAttribute('aria-controls'));box.onclick=()=>list.hidden=!list.hidden;list.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{box.textContent=option.textContent;list.hidden=true;void query();});});
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('#servers,#periods').forEach(n=>n.hidden=true);if(e.key==='Enter')void query();});
input.onchange=query;document.querySelectorAll('[role=tab]').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('[role=tab]').forEach(x=>x.setAttribute('aria-selected',String(x===tab)));cat=tab.textContent.toLowerCase();void query();});
${mode==='foreign'?"await fetch('http://127.0.0.1:9/forbidden');":''}
${mode==='nativeWS'?"const frame=document.createElement('iframe');document.body.append(frame);":''}
})();</script></body></html>`;}
