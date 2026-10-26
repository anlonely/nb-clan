import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext } from '../../../src/v2/context.jsx';
import { createQueryClient } from '../../../src/v2/query-client.js';
import SourceAdminPage from '../../../src/v2/source-admin/index.jsx';
const r = await fetch('/__fixture/session'), session = await r.json();
const client = createQueryClient(); client.setIdentity(session);
createRoot(document.getElementById('root')).render(<AppContext.Provider value={{client,go:path=>{location.href=path;}}}><SourceAdminPage/></AppContext.Provider>);
