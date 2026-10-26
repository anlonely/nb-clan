import test from 'node:test';
import assert from 'node:assert/strict';
import { managementNavigation, managementHome, managementSection } from '../src/v2/management-navigation.js';
import { sessionAuthReturnTo } from '../src/v2/auth-flow.js';
test('management-only accounts land on a visible section and use fixed local routes', () => {
  const session = { workspaces: { admin: true, member: false }, managementSections: [{ id: 'sync', path: 'https://invalid.example' }] };
  assert.equal(managementHome(session), '/admin/sync');
  assert.equal(sessionAuthReturnTo('/app/home', session), '/admin/sync');
  assert.deepEqual(managementNavigation({ ...session, managementSections: [] }), []);
  assert.deepEqual(managementNavigation({ ...session, workspaces: { admin: false } }), []);
  assert.equal(managementSection('/admin/publish-intents/local?x=1'), 'wipes');
  assert.equal(managementSection('/admin/platforms/bridge'), 'platforms');
  assert.equal(managementSection('/admin/members-other'), null);
});

test('inventory-only management entry retains its allowed query source', () => {
  assert.equal(managementHome({ workspaces: { admin: true }, managementSections: [{ id: 'stats', path: '/admin/stats/query?source=inventory' }] }), '/admin/stats/query?source=inventory');
});

test('legacy platform shortcuts no longer point to removed forwarding settings', () => {
  assert.equal(managementHome({ workspaces: { admin: true }, managementSections: [{ id: 'platforms', path: '/admin/platforms/relay' }] }), '/admin/platforms/discord');
  assert.equal(managementHome({ workspaces: { admin: true }, managementSections: [{ id: 'platforms', path: '/admin/platforms/bridge' }] }), '/admin/platforms/discord');
});

test('Bot management uses a scoped local landing page and recognises detail routes', () => {
  const session = { workspaces: { admin: true }, managementSections: [{ id: 'bot', path: '/admin/bot/features?platform=kook' }] };
  assert.equal(managementHome(session), '/admin/bot/features?platform=kook');
  assert.equal(managementSection('/admin/bot/open-signups/card_1?lang=en'), 'bot');
  assert.equal(managementSection('/admin/botnet'), null);
  assert.equal(managementHome({ ...session, managementSections: [{ id: 'bot', path: 'https://invalid.example' }] }), '/admin/bot/features');
});
