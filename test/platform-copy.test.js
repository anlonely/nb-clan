import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const languages = ['en', 'zh', 'ru', 'tr', 'th', 'ko', 'zh-CN', 'zh_TW', 'en-GB', 'ru_RU', 'ko-KR', 'TH_th', '  TR  ', 'de', '', null, undefined, 123];
const vars = { name: 'Example <name>', provider: 'Vital', label: 'VIP', purchasedAt: '2030-01-02', expiresAt: '2030-01-30',
  time: '<t:1:R>', url: 'https://example.test/?a=1', count: 0, limit: 10, metric: 'Kills', steamSuffix: false };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Recorded by evaluating the original api.js declarations before extraction.
// These fingerprints cover every catalog key, locale fallback, interpolation,
// command localization and display locale/currency/timezone; no legacy copy is bundled.
const golden = {
  default: { outputHash: '380ddec50ecc98a652d3ff13cedeb35cdcf2400bf59c04cd5cb800c65d12b5f6',
    catalogHash: '22636b24c7af51b968627020ee0dbb88c3447109b01d80d568fba971a024a888' },
  custom: { outputHash: 'd762ced3261999bcde52c73a7ada4f65dcf944316f4445e405ea1eb5e4bb3481',
    catalogHash: '780a10b6399d413501668a0b19d049c045586b87eed68c27e29f9fea3912f145' }
};
function outputs(copy) {
  const entries = [];
  for (const [catalog, fn] of [['DISCORD_TEXT', 'discordText'], ['DISCORD_REGISTRATION_CARD_TEXT', 'discordRegistrationCardText'], ['DISCORD_VITAL_VIP_TEXT', 'discordVitalVipText']]) {
    const keys = [...new Set(Object.values(copy[catalog]).flatMap(Object.keys))].sort().concat('__missing_key__');
    for (const language of languages) for (const key of keys) for (const input of [{}, vars])
      entries.push([fn, language, key, copy[fn](language, key, input)]);
  }
  for (const language of languages) entries.push(['locale', language, copy.discordTextLanguage(language),
    copy.discordIntlLocale(language), copy.discordDisplayCurrency(language), copy.discordDisplayTimeZone(language)]);
  for (const key of Object.keys(copy.DISCORD_TEXT.en).sort()) entries.push(['localizations', key, copy.discordTextLocalizations(key)]);
  return entries;
}
for (const [name, brand, origin] of [['default', '', ''], ['custom', 'Example Guild', 'https://guild.example.test']]) {
  test(`extracted platform copy matches 6,822 original outputs with ${name} branding`, async () => {
    const saved = Object.fromEntries(['NB_BRAND_NAME', 'NB_V2_PUBLIC_ORIGIN', 'NB_PUBLIC_BASE_URL'].map(key => [key, process.env[key]]));
    let copy;
    try {
      process.env.NB_BRAND_NAME = brand;
      process.env.NB_V2_PUBLIC_ORIGIN = origin;
      delete process.env.NB_PUBLIC_BASE_URL;
      copy = await import(`../server/platform-copy/discord.js?brand=${name}`);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    const rendered = outputs(copy);
    assert.equal(rendered.length, 6822);
    assert.equal(hash(rendered), golden[name].outputHash);
    assert.equal(hash([copy.DISCORD_TEXT, copy.DISCORD_REGISTRATION_CARD_TEXT, copy.DISCORD_VITAL_VIP_TEXT]), golden[name].catalogHash);
    assert.equal(copy.discordTextLanguage('zh_TW'), 'zh');
    assert.equal(copy.discordIntlLocale('de-DE'), 'en-US');
    assert.equal(copy.discordDisplayCurrency('ko-KR'), 'KRW');
    assert.equal(copy.discordDisplayTimeZone('zh-CN'), 'Asia/Shanghai');
    assert.equal(copy.discordText('en', '__missing_key__'), '__missing_key__');
    assert.equal(copy.discordText('en', 'memberRemoved', { name: 'Alice', steamSuffix: 0 }), 'Member removed: Alice0.');
    assert.ok(copy.discordText('en', 'footerMemberSystem').startsWith(brand || 'Clan Portal'));
  });
}
