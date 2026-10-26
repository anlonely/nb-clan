import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
export const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,'../../..');
const require=createRequire(new URL('../../../package.json', import.meta.url));
export const config=()=>({root:directory,configFile:false,cacheDir:path.join(directory,'.runtime/vite-cache'),envFile:false,envDir:false,plugins:[react()],resolve:{alias:['react/jsx-dev-runtime','react/jsx-runtime','react-dom/client','react-dom','react'].map(name=>({find:new RegExp('^'+name+'$'),replacement:require.resolve(name)}))},server:{middlewareMode:true,fs:{allow:[root,decodeURIComponent(new URL('../../../node_modules', import.meta.url).pathname)]}},build:{outDir:path.join(directory,'.runtime/build'),emptyOutDir:true,rollupOptions:{input:path.join(directory,'index.html')}}});
