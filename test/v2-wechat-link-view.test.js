import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundled = await build({
  stdin: { contents: "export { LinkForm } from './wechat-link.jsx'; export { AppContext } from './context.jsx'; export { setUiLocale } from './i18n.js';", resolveDir: fileURLToPath(new URL('../src/v2/', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', loader: { '.css': 'empty' },
  plugins: [{ name: 'same-react-runtime', setup(builder) { builder.onResolve({ filter: /^(react|lucide-react|qrcode)$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true })); } }]
});
const { LinkForm, AppContext, setUiLocale } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

for (const locale of ['zh', 'en']) for (const mapping of [
  { provider: 'wechat:current_app', verifiedAt: null },
  { provider: 'wechat:another_app', verifiedAt: '2026-09-24T00:00:00Z' }
]) test(`${locale} website does not mistake ${mapping.provider} ${mapping.verifiedAt ? 'verified' : 'legacy'} mapping for this app link completion`, () => {
  setUiLocale(locale);
  const data = { profile: { displayName: '关联测试' }, bindings: { steam: { status: 'verified', steamId: '76561198000000002' },
    platforms: [{ provider: 'kook', verifiedAt: '2026-09-24T00:00:00Z', externalId: 'kook-test' }, mapping] } };
  const markup = renderToStaticMarkup(React.createElement(AppContext.Provider, { value: { client: {}, online: true, go() {} } }, React.createElement(LinkForm, { data })));
  assert.match(markup, /关联测试/); // User-provided names retain their original language.
  assert.match(markup, locale === 'zh' ? /确认将我的微信关联到以上成员账号/ : /I confirm linking my WeChat account/);
  assert.match(markup, locale === 'zh' ? /核对微信并继续/ : /Verify WeChat and continue/);
  assert.match(markup, locale === 'zh' ? /生成关联二维码/ : /Generate linking QR code/);
  assert.doesNotMatch(markup, /微信关联成功|当前账号已关联微信|WeChat linked successfully/);
});
