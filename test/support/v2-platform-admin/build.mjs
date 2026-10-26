import '../v2-baseline/loopback-only.mjs';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {root} from './config.mjs';
await build({root,configFile:false,envFile:false,envDir:false,plugins:[react()],build:{outDir:`${root}/test/support/v2-platform-admin/.runtime/build`,emptyOutDir:true,rollupOptions:{input:`${root}/test/support/v2-platform-admin/index.html`}}});
