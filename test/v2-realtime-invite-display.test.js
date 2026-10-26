import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteDisplayName } from '../src/v2/realtime/invite-display.js';

test('inviter names prefer meaningful source names, then roster and invitee history', () => {
  const steamId = '76561198215422345';
  const members = [{ steamId, displayName: 'JackOgSpaniard' }];
  assert.equal(inviteDisplayName({ name: 'Jack', steamId, members }), 'Jack');
  assert.equal(inviteDisplayName({ name: steamId, steamId, members }), 'JackOgSpaniard');
  assert.equal(inviteDisplayName({ name: steamId, steamId, records: [{ inviteeSteamId: steamId, inviteeName: 'Earlier Jack' }] }), 'Earlier Jack');
  assert.equal(inviteDisplayName({ name: steamId, steamId }), '');
});
