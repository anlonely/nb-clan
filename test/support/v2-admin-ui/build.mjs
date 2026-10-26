// Compile the standalone entry without changing the public App/Vite entry.
import '../v2-baseline/loopback-only.mjs';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { root } from './config.mjs';
await build({root,configFile:false,envFile:false,envDir:false,plugins:[react()],
 build:{outDir:path.join(root,'work/g06-a/runtime-build'),emptyOutDir:true,rollupOptions:{input:path.join(root,'test/support/v2-admin-ui/index.html')}}});
