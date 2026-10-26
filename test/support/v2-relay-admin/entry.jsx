import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext } from '../../../src/v2/context.jsx';
import { createQueryClient } from '../../../src/v2/query-client.js';
const RelayAdminPage=React.lazy(()=>import('../../../src/v2/relay-admin/index.jsx'));
async function start(){
const client=createQueryClient(),identity=await fetch('/__fixture/session').then(r=>r.json());client.setIdentity(identity);
createRoot(document.getElementById('root')).render(<AppContext.Provider value={{client}}><Suspense fallback={<p>正在加载…</p>}><RelayAdminPage/></Suspense></AppContext.Provider>);
}
void start();
