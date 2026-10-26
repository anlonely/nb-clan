import React from 'react';
import {createRoot} from 'react-dom/client';
import {AppContext} from '../../../src/v2/context.jsx';
import {createQueryClient} from '../../../src/v2/query-client.js';
import PlatformAdmin from '../../../src/v2/platform-admin/index.jsx';
import '../../../src/v2/style.css';
const identity=await fetch('/__fixture/session').then(r=>r.json()),client=createQueryClient();client.setIdentity(identity);
createRoot(document.getElementById('root')).render(<AppContext.Provider value={{client,path:'/admin/platforms/discord',online:true,go:()=>{}}}><main style={{maxWidth:1200,margin:'20px auto'}}><PlatformAdmin/></main></AppContext.Provider>);
