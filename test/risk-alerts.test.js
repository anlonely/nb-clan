import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountRiskRuleMatches,
  buildMemberNotifications,
  defaultAccountRiskRules,
  shouldShowPrivateInventoryAlert,
  shouldShowPrivatePlayTimeAlert
} from '../src/shared/risk-alerts.js';

const translate = (key) => key;

function defaultRule(id) {
  return defaultAccountRiskRules().find((rule) => rule.id === id);
}

test('private inventory is not treated as a zero-value low inventory alert', () => {
  const member = {
    id: 'private_inventory',
    displayName: 'Private Inventory',
    accountSignals: {
      playTimeKnown: true,
      playTimeMinutes: 600 * 60,
      inventoryPublic: false,
      inventoryValue: 0,
      inventoryCurrency: 'USD'
    }
  };

  assert.equal(accountRiskRuleMatches(defaultRule('low-inventory'), member), false);
  assert.equal(shouldShowPrivateInventoryAlert(member), true);
  assert.equal(buildMemberNotifications([member], translate, 'en', {}, new Set(), null, [defaultRule('low-inventory')]).length, 0);
});

test('private Steam playtime stays private even when BattleMetrics time is known', () => {
  const member = {
    id: 'private_playtime',
    displayName: 'Private Playtime',
    accountSignals: {
      playTimeKnown: false,
      playTimeMinutes: 0,
      onlineTimeKnown: true,
      onlineTimeMinutes: 240,
      inventoryPublic: true,
      inventoryValue: 100,
      inventoryCurrency: 'USD'
    }
  };

  assert.equal(accountRiskRuleMatches(defaultRule('low-game-hours'), member), false);
  assert.equal(shouldShowPrivatePlayTimeAlert(member), true);
  assert.equal(buildMemberNotifications([member], translate, 'en', {}, new Set(), null, [defaultRule('low-game-hours')]).length, 0);
});

test('confirmed public zero inventory still participates in low inventory rules', () => {
  const member = {
    id: 'public_empty_inventory',
    displayName: 'Public Empty Inventory',
    accountSignals: {
      playTimeKnown: true,
      playTimeMinutes: 600 * 60,
      inventoryPublic: true,
      inventoryVisibility: 'public',
      inventoryValue: 0,
      inventoryCurrency: 'USD'
    }
  };

  assert.equal(accountRiskRuleMatches(defaultRule('low-inventory'), member), true);
  assert.equal(shouldShowPrivateInventoryAlert(member), false);
});
