import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  deps = decodeURIComponent(new URL('../../../node_modules', import.meta.url).pathname);
await build({
  root,
  configFile: false,
  envDir: false,
  envFile: false,
  plugins: [react()],
  resolve: {
    alias: [{
      find: /^(react(?:-dom)?)(\/.*)?$/,
      replacement: deps + '/$1$2'
    }, {
      find: 'lucide-react',
      replacement: deps + '/lucide-react/dist/esm/lucide-react.js'
    }]
  },
  build: {
    outDir: path.join(root, 'test/support/v2-realtime/.runtime/build'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(root, 'test/support/v2-realtime/index.html')
    }
  },
  cacheDir: path.join(root, 'test/support/v2-realtime/.cache')
});
