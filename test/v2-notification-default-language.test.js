import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalNotificationCatalog } from '../server/v2/candidate-host/notifications.js';

test('Discord notification targets default to English while KOOK keeps Chinese first', () => {
  const service = {
    identity: {},
    config(platform) { return { enabled: true, revision: 1, commands: [], targets: [
      { id: `${platform}-target`, guildId: '100000000000000001', channelId: '100000000000000002', enabled: true, name: platform },
    ] }; },
  };
  const targets = canonicalNotificationCatalog(() => service).listTargets();
  assert.equal(targets.find(target => target.platform === 'discord').languages[0], 'en');
  assert.equal(targets.find(target => target.platform === 'kook').languages[0], 'zh-CN');
  assert.ok(targets.find(target => target.platform === 'discord').languages.includes('zh-CN'));
});
