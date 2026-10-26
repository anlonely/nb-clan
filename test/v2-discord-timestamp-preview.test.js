import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/v2/discord-timestamp-text.jsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'], logLevel: 'silent' });
const module = { exports: {} };
Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { DiscordTimestampText } = module.exports;
const instant = new Date('2030-09-08T16:00:00Z'), seconds = instant.getTime() / 1000;
const render = (children, platform = 'discord') => renderToStaticMarkup(createElement(DiscordTimestampText, { platform }, children));
const escape = value => renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);

test('Discord preview uses the viewer environment timezone, retaining the precise UTC instant', () => {
  const originalZone = process.env.TZ;
  try {
    const labels = [];
    for (const zone of ['Asia/Shanghai', 'America/New_York']) {
      process.env.TZ = zone;
      const label = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(instant);
      const markup = render(`WIPE: <t:${seconds}:F>`);
      assert.ok(markup.includes(`>${escape(label)}</time>`));
      assert.ok(markup.includes(`(${zone})`));
      assert.ok(markup.includes('dateTime="2030-09-08T16:00:00.000Z"'));
      assert.equal(markup.includes('&lt;t:'), false);
      labels.push(label);
    }
    assert.notEqual(labels[0], labels[1]);
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test('all absolute styles and the default Discord format produce safe time elements', () => {
  const input = ['t', 'T', 'd', 'D', 'f', 'F'].map(style => `<t:${seconds}:${style}>`).join(' ') + ` <t:${seconds}>`;
  const markup = render(input);
  assert.equal((markup.match(/<time /g) || []).length, 7);
  assert.equal(markup.includes('&lt;t:'), false);
});

test('relative style is localized against the current browser clock', t => {
  t.mock.method(Date, 'now', () => instant.getTime() - 3600_000);
  const label = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(1, 'hour');
  assert.ok(render(`<t:${seconds}:R>`).includes(`>${escape(label)}</time>`));
});

test('inline and fenced code remain literal, including an unclosed code block', () => {
  for (const code of [`\`<t:${seconds}:F>\``, `\`\`<t:${seconds}:F>\`\``, `\`\`\`text\n<t:${seconds}:F>\n\`\`\``, `\`\`\`\n<t:${seconds}:F>`]) {
    const markup = render(`Outside <t:${seconds}:t> ${code}`);
    assert.equal((markup.match(/<time /g) || []).length, 1);
    assert.ok(markup.includes(escape(code)));
  }
});

test('KOOK, unknown platforms, invalid tokens and HTML remain literal escaped text', () => {
  const token = `<t:${seconds}:F>`;
  for (const platform of ['kook', 'wechat', undefined]) {
    const markup = renderToStaticMarkup(createElement(DiscordTimestampText, { platform }, token));
    assert.equal(markup, escape(token));
  }
  const invalid = '<t:9999999999999999:F> <t:NaN:F> <t:23:X>';
  assert.equal(render(invalid), escape(invalid));
  const malicious = `<script>alert(1)</script><img src=x onerror=alert(1)>${token}`;
  const markup = render(malicious);
  assert.equal(markup.includes('<script>'), false);
  assert.equal(markup.includes('<img '), false);
  assert.ok(markup.includes('&lt;script&gt;'));
  assert.ok(markup.includes('<time '));
});
