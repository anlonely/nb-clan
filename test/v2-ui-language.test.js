import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, getUiLocale, setUiLocale, dateLocale, subscribeUiLocale, englishCopy, UI_LANGUAGE_KEY } from '../src/v2/i18n.js';

test('UI language changes without changing business preferences or user content', () => {
  const previous = getUiLocale(), stored = new Map([['notification-language', 'zh-CN'], ['timeZone', 'Asia/Shanghai']]);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } });
  let changes = 0; const stop = subscribeUiLocale(() => changes++);
  try {
    setUiLocale('zh'); changes = 0;
    setUiLocale('en');
    assert.equal(t('你好，{name}。', { name: '中文队友' }), 'Hello, 中文队友.');
    assert.equal(t('专长'), 'Specialties');
    assert.equal(t('管道'), 'Industrial piping');
    assert.equal(t('枪男'), 'Fragger');
    assert.equal(t('指挥'), 'Shot caller');
    assert.equal(t('自定义服务器名'), '自定义服务器名');
    assert.equal(dateLocale(), 'en-US');
    assert.equal(stored.get(UI_LANGUAGE_KEY), 'en');
    assert.equal(stored.get('notification-language'), 'zh-CN');
    assert.equal(stored.get('timeZone'), 'Asia/Shanghai');
    setUiLocale('en'); assert.equal(changes, 1);
    setUiLocale('zh'); assert.equal(t('专长'), '专长'); assert.equal(changes, 2);
  } finally { stop(); if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; setUiLocale(previous); }
});

test('blocked browser storage does not prevent language switching', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  try { setUiLocale('en-US'); assert.equal(t('报名已保存'), 'Sign-up saved'); setUiLocale('zh'); }
  finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});

test('English catalog preserves every named placeholder and contains no untranslated Chinese', () => {
  const keys = text => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();
  for (const [source, translation] of Object.entries(englishCopy)) {
    assert.equal(typeof translation, 'string', source);
    assert.ok(translation.trim(), source);
    assert.doesNotMatch(translation, /[\u3400-\u9fff]/, source);
    assert.deepEqual(keys(translation), keys(source), source);
  }
});

test('every static Chinese UI translation call has an English catalog entry', () => {
  const root = fileURLToPath(new URL('../src/v2/', import.meta.url)), missing = [];
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'locales') inspect(filename);
      else if (entry.isFile() && /\.(?:jsx|js)$/.test(entry.name)) {
        const source = readFileSync(filename, 'utf8');
        for (const match of source.matchAll(/\bt\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
          const literal = match[1];
          const key = literal.startsWith('"') ? JSON.parse(literal)
            : JSON.parse('"' + literal.slice(1, -1).replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"');
          if (/[\u3400-\u9fff]/.test(key) && !Object.hasOwn(englishCopy, key)) missing.push(`${path.relative(root, filename)}: ${key}`);
        }
      }
    }
  }
  inspect(root);
  assert.deepEqual(missing, []);
});
