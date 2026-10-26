import test from 'node:test';
import { time } from '../src/v2/format.js';
import assert from 'node:assert/strict';
import { displayTimeZone, automaticTimeZone, setDisplayTimeZone, validTimeZone, displayTimeZoneSnapshot } from '../src/v2/display-preferences.js';

function replaceGlobal(name, value) {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  return () => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name];
}

test('browser primary language chooses Chinese only for Chinese; explicit choice wins', async () => {
  const stored = new Map(), browser = { languages: ['de-DE', 'zh-CN'], language: 'de-DE' };
  const events = new EventTarget();
  const undo = [replaceGlobal('navigator', browser), replaceGlobal('localStorage', {
    getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value)
  }), replaceGlobal('addEventListener', events.addEventListener.bind(events)), replaceGlobal('removeEventListener', events.removeEventListener.bind(events))];
  let stop;
  try {
    const i18n = await import('../src/v2/i18n.js?browser-preferences');
    for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-HK']) assert.equal(i18n.normalizeUiLocale(language), 'zh');
    for (const language of ['en-US', 'de-DE', 'ru-RU', 'ja-JP', 'fr-FR']) assert.equal(i18n.normalizeUiLocale(language), 'en');
    assert.equal(i18n.getUiLocale(), 'en');
    stop = i18n.subscribeUiLocale(() => {});
    browser.languages = ['zh-TW']; events.dispatchEvent(new Event('languagechange'));
    assert.equal(i18n.getUiLocale(), 'zh');
    i18n.setUiLocale('en'); events.dispatchEvent(new Event('languagechange'));
    assert.equal(i18n.getUiLocale(), 'en');
    assert.equal((await import('../src/v2/i18n.js?persisted-browser-preferences')).getUiLocale(), 'en');
  } finally { stop?.(); undo.reverse().forEach(fn => fn()); }
});

test('automatic display zone follows device changes, manual selection persists, invalid zones are rejected', async () => {
  const originalTZ = process.env.TZ, stored = new Map();
  const undo = replaceGlobal('localStorage', {getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)});
  try {
    setDisplayTimeZone(''); process.env.TZ = 'America/New_York';
    assert.equal(automaticTimeZone(), true); assert.equal(displayTimeZone(), 'America/New_York');
    const previous = displayTimeZoneSnapshot(); process.env.TZ = 'Europe/Berlin';
    assert.equal(displayTimeZone(), 'Europe/Berlin'); assert.notEqual(displayTimeZoneSnapshot(), previous);
    setDisplayTimeZone('Asia/Shanghai'); assert.equal(automaticTimeZone(), false);
    assert.equal(displayTimeZone(), 'Asia/Shanghai');
    assert.equal((await import('../src/v2/display-preferences.js?persisted')).displayTimeZone(), 'Asia/Shanghai');
    assert.throws(()=>setDisplayTimeZone('invalid/zone'), RangeError); assert.equal(validTimeZone('invalid/zone'), '');
    setDisplayTimeZone(''); assert.equal(displayTimeZone(), 'Europe/Berlin');
  } finally { setDisplayTimeZone(''); undo(); if(originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
});

test('one UTC instant displays correctly across zones and daylight-saving transitions without mutation', () => {
  const source = '2026-03-08T07:30:00Z';
  try {
    setDisplayTimeZone('America/New_York');
    assert.match(time(source), /03:30/);
    assert.match(time('2026-03-08T06:30:00Z'), /01:30/);
    setDisplayTimeZone('Europe/Berlin'); assert.match(time(source), /08:30/);
    setDisplayTimeZone('Asia/Shanghai'); assert.match(time(source), /15:30/);
  } finally { setDisplayTimeZone(''); }
  assert.equal(source,'2026-03-08T07:30:00Z');
});
