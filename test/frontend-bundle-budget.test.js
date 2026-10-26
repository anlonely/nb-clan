import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_INITIAL_JS_BYTES = 300 * 1024;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
  }));
  return nested.flat();
}

test('production entry stays lightweight and does not ship the loading WASM', async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-frontend-'));
  try {
    await build({
      root: repoRoot,
      configFile: path.join(repoRoot, 'vite.config.js'),
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true
      }
    });

    const files = await listFiles(outDir);
    assert.equal(files.some((file) => file.endsWith('.wasm')), false, 'loading WASM must not be emitted');
    assert.equal(files.some((file) => file.endsWith('.lottie')), false, 'loading Lottie files must not be emitted');

    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.dependencies?.['@lottiefiles/dotlottie-wc'], undefined, 'loading Lottie runtime must stay removed');

    const retirementWorker = await readFile(path.join(outDir, 'loading-cache-sw.js'), 'utf8');
    assert.match(retirementWorker, /registration\.unregister\(\)/, 'legacy loading cache worker must unregister itself');
    assert.doesNotMatch(retirementWorker, /addEventListener\(['"]fetch['"]/, 'retirement worker must not intercept requests');

    const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
    const initialAssets = new Set(
      [...html.matchAll(/(?:src|href)="\/([^"?]+\.js)"/g)].map((match) => match[1])
    );
    const initialSizes = await Promise.all(
      [...initialAssets].map(async (asset) => (await stat(path.join(outDir, asset))).size)
    );
    const initialJsBytes = initialSizes.reduce((sum, size) => sum + size, 0);

    assert.ok(initialAssets.size > 0, 'expected at least one initial JavaScript asset');
    assert.ok(
      initialJsBytes <= MAX_INITIAL_JS_BYTES,
      `initial JavaScript is ${initialJsBytes} bytes; budget is ${MAX_INITIAL_JS_BYTES}`
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
