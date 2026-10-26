import React from 'react';
import {createRoot} from 'react-dom/client';
import {AppContext} from '../../../src/v2/context.jsx';
import {createQueryClient} from '../../../src/v2/query-client.js';
import PlatformAdmin from '../../../src/v2/platform-admin/index.jsx';
import '../../../src/v2/style.css';
// UI-only deterministic response seam. Domain/worker/HTTP evidence is separate.
const calls=[],receipts=new Map();window.uiFixture={calls,receiptState:'failed'};
const client=createQueryClient({fetchImpl:async(path,options)=>{
 let data;
 if(path.endsWith('/audit')||path==='/api/v2/source-admin'||path==='/api/v2/relay-admin')data={items:[]};
 else if(path.includes('/operations/')){const id=path.split('/').pop();data={operationId:id,status:window.uiFixture.receiptState};}
 else if(options.method==='POST'){const input=JSON.parse(options.body),id=options.headers.get('Idempotency-Key');calls.push({id,input});const state=input.steamId||'failed';data={operationId:id,status:state,result:{state:state==='result_unknown'?'unknown':state,items:[]}};receipts.set(id,data);}
 else data={revision:1,enabled:true,applicationId:'fixture',targets:[],commands:[],secretStatus:{},canConfigure:true,validation:{state:'unverified'},actions:[{id:'query',available:true}]};
 return new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
}});
createRoot(document.getElementById('root')).render(<AppContext.Provider value={{client,path:'/admin/platforms/discord',online:true,go:()=>{}}}><main style={{maxWidth:1200,margin:'20px auto'}}><p>本地桌面状态流程验证 · 构造响应 · 无外发</p><PlatformAdmin/></main></AppContext.Provider>);
