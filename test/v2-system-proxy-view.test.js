import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: "export { Proxy } from './system-admin/index.jsx'; export { setUiLocale } from './i18n.js';", resolveDir: fileURLToPath(new URL('../src/v2/', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^(react|lucide-react)$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true })); } }]
});
const { Proxy, setUiLocale } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const nodeId = '1234567890abcdef';
const data = { revision: 3, enabled: false, nodes: [{ id: nodeId, name: 'Saved server node' }],
  saved: { enabled: true, nodeId, scope: 'global', endpoint: '' },
  effective: { battlemetrics: { enabled: false, endpoint: '', source: 'disabled' }, kda: { enabled: false, endpoint: '', source: 'disabled' } } };
const render = (overrides = {}, props = {}) => renderToStaticMarkup(React.createElement(Proxy, { data: { ...data, ...overrides }, write: true, busy: false, run() {}, ...props }));

test('proxy switch clearly shows direct mode and keeps the configured node selectable', () => {
  setUiLocale('zh');
  const markup = render();
  assert.match(markup, /role="switch"[^>]*aria-checked="false"/);
  assert.match(markup, /代理总开关/); assert.match(markup, /已关闭 · 全部直连/);
  assert.match(markup, /包含环境代理/); assert.match(markup, /Saved server node/);
  assert.equal((markup.match(/检测直连/g) || []).length, 2);
  assert.equal((markup.match(/disabled=""/g) || []).length, 0, 'turning off does not disable saved-node editing');
});

test('enabled state and pending or read-only guards apply to the native switch', () => {
  setUiLocale('zh');
  assert.match(render({ enabled: true }), /role="switch"[^>]*aria-checked="true"[^>]*checked=""/);
  for (const props of [{ write: false }, { busy: true }]) assert.match(render({}, props), /role="switch"[^>]*disabled=""/);
});

test('a missing saved node and masked legacy endpoint remain visible while off', () => {
  setUiLocale('zh');
  assert.match(render({ nodes: [] }), /已保存节点/);
  assert.match(render({ nodes: [] }), new RegExp(nodeId));
  assert.match(render({ saved: { enabled: true, nodeId: '', scope: 'global', endpoint: 'http://***@127.0.0.1:9999' } }), /http:\/\/\*\*\*@127.0.0.1:9999/);
});

test('the proxy master state and direct-connection controls are translated', () => {
  setUiLocale('en');
  const markup = render();
  assert.match(markup, /Proxy master switch/);
  assert.match(markup, /Off · All connections are direct/);
  assert.match(markup, /Test direct connection/);
  assert.doesNotMatch(markup, /代理总开关|已关闭 · 全部直连|检测直连/);
});
