import test from 'node:test';
import assert from 'node:assert/strict';
import { brandName, siteOrigin } from '../server/branding.js';
import { DEFAULT_CHINA_ELECTRICIANS, DEFAULT_FOREIGN_ELECTRICIANS } from '../shared/electrician-defaults.js';
import { welcomeGuideDetails } from '../server/v2/platform-admin/welcome-guide-card.js';

test('public defaults contain no roster and reject markup or credential-bearing deployment values', () => {
  assert.equal(DEFAULT_CHINA_ELECTRICIANS, ''); assert.equal(DEFAULT_FOREIGN_ELECTRICIANS, '');
  assert.equal(brandName({NB_BRAND_NAME: 'Test Community'}), 'Test Community');
  for (const value of ['<img onerror=alert(1)>', '[spoof](url)', 'x\ny']) assert.equal(brandName({NB_BRAND_NAME:value}), 'Clan Portal');
  for (const value of ['https://user:password@example.com', 'javascript:alert(1)', 'https://example.com/path', 'https://example.com?secret=test']) assert.equal(siteOrigin({NB_V2_PUBLIC_ORIGIN:value}), 'https://clan.example.com');
});

test('community links follow the explicit deployment origin rather than a fixed author site', () => {
  const old = process.env.NB_V2_PUBLIC_ORIGIN;
  try {
    process.env.NB_V2_PUBLIC_ORIGIN = 'https://community.example.org';
    const details = welcomeGuideDetails({guildId:'100000000000000001',electricianChannelId:'100000000000000002',serverConnectChannelId:'100000000000000003'});
    for (const key of ['bindingUrl','tutorialUrl','electricianProfilesUrl']) assert.equal(new URL(details[key]).origin, 'https://community.example.org');
  } finally { if (old === undefined) delete process.env.NB_V2_PUBLIC_ORIGIN; else process.env.NB_V2_PUBLIC_ORIGIN = old; }
});
