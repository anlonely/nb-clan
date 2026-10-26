import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

test('source configuration renders its active pane in both languages and translates runtime guidance', async () => {
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'source-ui-'));
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const outfile = join(temporary, 'render.mjs');
    await build({ stdin: { contents: `export {default as SourceAdminPage} from './src/v2/source-admin/index.jsx';
      export {AppContext} from './src/v2/context.jsx'; export {setUiLocale} from './src/v2/i18n.js';`, resolveDir: resolve('.') },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
    const { SourceAdminPage, AppContext, setUiLocale } = await import(pathToFileURL(outfile).href);
    const snapshot = { data: { items: [{ id: 'kda', name: 'KDA 来源', canWrite: false, revision: 'fixture',
      storeConfigured: false, providerAvailable: false, runtimeStatusKnown: true, effectiveSource: 'none',
      capabilities: ['按服务器与 Wipe 读取战绩'], keys: [],
      mapping: ['服务器/Wipe 对应关系来自档期的服务器快照。'],
      runtimeNote: '采集服务尚未接入，保存凭据不会启用采集。' }] } };
    const client = { getGeneration: () => 1, getIdentity: () => ({ accountId: 'fixture-owner' }),
      getQueryState: () => snapshot, subscribeQuery: () => () => {}, fetchQuery: async () => snapshot.data };
    const render = locale => {
      setUiLocale(locale);
      return renderToStaticMarkup(React.createElement(AppContext.Provider, { value: { client, go() {} } }, React.createElement(SourceAdminPage)));
    };
    for (const locale of ['zh', 'en']) {
      const html = render(locale);
      const panes = html.match(/<div class="source-content"[^>]*>/g);
      assert.equal(panes.length, 3);
      assert.equal(panes.filter(pane => !pane.includes('hidden')).length, 1, `${locale} must retain one visible active pane`);
      assert.match(html, locale === 'en' ? /KDA sources/ : /KDA 来源/);
      if (locale === 'en') {
        assert.match(html, /Read stats by server and wipe/);
        assert.match(html, /Server and wipe mappings come from the server snapshot saved for the wipe event/);
        assert.match(html, /Saving credentials will not enable collection/);
        assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
      }
    }
  } finally {
    if (previousStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousStorage;
    await rm(temporary, { recursive: true, force: true });
  }
});
