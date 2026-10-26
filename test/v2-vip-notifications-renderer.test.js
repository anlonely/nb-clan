import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { renderVip, preferredVipLanguage } from '../server/v2/vip-notifications/renderer.js';
import { vipSnapshot } from '../server/v2/vip-notifications/model.js';

const member = { id: 'vip-member', revision: 7, vitalVipType: 'priority', vitalVipPurchasedAt: '2030-08-11', vitalVipExpiresAt: '2030-09-08' };
const boundary = Date.parse('2030-09-08T16:00:00.000Z');

test('VIP date-only expiry renders the actual UTC+8 expiry boundary and preserves stored dates', () => {
  const vip = vipSnapshot(member, 'vital', boundary - 1);
  const rendered = renderVip(member, vip, 'en');
  assert.equal(vip.expired, false);
  assert.equal(vipSnapshot(member, 'vital', boundary).expired, true);
  assert.match(rendered.payload.embeds[0].description, new RegExp(`<t:${boundary / 1000}:F>`));
  assert.equal(rendered.snapshot.expiresAt, '2030-09-08');
  assert.equal(rendered.snapshot.purchasedAt, '2030-08-11');
  assert.equal(vip.expiresAt, '2030-09-08');
});

test('every VIP language and source receives a viewer-local native timestamp', () => {
  for (const language of ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko']) {
    for (const source of ['vital', 'rustinity', 'atlas']) {
      const vip = { source, type: 'queue_skip', purchasedAt: '2030-08-11', expiresAt: '2030-09-08' };
      const rendered = renderVip(member, vip, language);
      assert.ok(rendered.payload.embeds[0].description.includes(`<t:${boundary / 1000}:F>`));
      assert.equal(rendered.payload.embeds[0].footer.text, `Clan Portal · ${source === 'vital' ? 'Vital' : source === 'atlas' ? 'Atlas' : 'Rustinity'} VIP`);
      assert.doesNotMatch(JSON.stringify(rendered.payload), /NB Clan/);
    }
  }
});

test('VIP client locale covers six languages and never uses guild locale as the user preference', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE json_records(collection TEXT,id TEXT,position INTEGER,updated_at TEXT,payload_json TEXT)');
    const insert = db.prepare('INSERT INTO json_records VALUES(?,?,?,?,?)');
    const cases = [
      [{ discordLocale: 'zh-TW', discordLanguage: 'en', discordGuildLocale: 'ru' }, 'zh-CN'],
      [{ discordLocale: 'en-GB', discordGuildLocale: 'zh-CN' }, 'en'],
      [{ discordLocale: 'ru', discordGuildLocale: 'zh-CN' }, 'ru'],
      [{ discordLocale: 'tr', discordGuildLocale: 'zh-CN' }, 'tr'],
      [{ discordLocale: 'th', discordGuildLocale: 'zh-CN' }, 'th'],
      [{ discordLocale: 'ko', discordGuildLocale: 'zh-CN' }, 'ko'],
      [{ discordLocale: 'ko_KR', discordGuildLocale: 'zh-CN' }, 'ko'],
      [{ discordLocale: 'de', discordLanguage: 'zh-CN', discordGuildLocale: 'ru' }, 'en'],
      [{ discordGuildLocale: 'zh-CN' }, 'en'],
      [{ discordLocale: '<@everyone>', discordGuildLocale: 'zh-CN' }, 'en'],
      [{ discordLocale: '<@everyone>', discordLanguage: 'ru', discordGuildLocale: 'zh-CN' }, 'ru'],
      [{ discordLanguage: 'zh-CN', discordGuildLocale: 'ko' }, 'zh-CN'],
      [{ discordLanguage: 'tr-TR' }, 'tr'],
      [{ discordLanguage: 'unsupported' }, 'en'],
      [{}, 'en'],
    ];
    for (const [index, [metadata, expected]] of cases.entries()) {
      const externalId = `client-${index}`;
      insert.run('discordMemberApplications', externalId, 0, '2030-01-01T00:00:00Z', JSON.stringify({ discordUserId: externalId, ...metadata }));
      assert.equal(preferredVipLanguage(db, externalId), expected, JSON.stringify(metadata));
    }
    assert.equal(preferredVipLanguage(db, 'unrecorded-client'), 'en');
  } finally { db.close(); }
});

test('absolute VIP instants retain their precise time and offset', () => {
  const vip = { source: 'atlas', type: 'priority', expiresAt: '2030-09-08T20:30:00+02:00' };
  const description = renderVip(member, vip, 'en').payload.embeds[0].description;
  assert.ok(description.includes(`<t:${Date.parse(vip.expiresAt) / 1000}:F>`));
});

test('leap-day expiry uses the same proven date boundary without normalizing invalid dates', () => {
  const vip = { source: 'vital', type: 'priority', expiresAt: '2032-02-29' };
  assert.ok(renderVip(member, vip, 'en').payload.embeds[0].description.includes(`<t:${Date.parse('2032-02-29T16:00:00Z') / 1000}:F>`));
  const invalid = renderVip(member, { ...vip, expiresAt: '2030-02-30' }, 'en');
  assert.equal(invalid.payload.embeds[0].description.includes('<t:'), false);
});
