import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/v2-native-platform-metadata/fixture.mjs';

async function setup(t) {
  const f = await fixture(); t.after(() => f.close());
  const config = f.service.config('discord');
  f.service.save(f.identity.actorForAccount('admin'), 'discord', {expectedRevision: config.revision, config: {
    targets: [{...config.targets[0], enabledCommandIds: [...config.targets[0].enabledCommandIds, 'setsteam', 'view', 'newwipe', 'event']}],
    commands: [
      ...['setsteam', 'view'].map(id => ({id, type: 'slash_command', slashCommand: id, enabled: true})),
      {id: 'newwipe', type: 'event_command', slashCommand: 'newwipe', enabled: true},
      {id: 'event', type: 'event_command', slashCommand: 'gather', enabled: true}
    ]}}, {operationId: randomUUID()});
  return f;
}

test('registering Steam commands only upserts the selected guild commands and receipt replay does not write again', async t => {
  const f = await setup(t), guild = new Map([['unrelated', {id: '800000000000000011', name: 'unrelated', type: 1}], ['map', {id: '800000000000000012', name: 'map', type: 1}]]);
  const before = structuredClone([...guild]);
  f.fault = ({req, res, body}) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v10/applications/500000000000000001/guilds/100000000000000001/commands');
    assert.ok(['setsteam', 'view'].includes(body.name));
    const row = {...body, id: body.name === 'setsteam' ? '800000000000000013' : '800000000000000014',
      application_id: '500000000000000001', guild_id: '100000000000000001'};
    guild.set(body.name, row); res.statusCode = 201; res.end(JSON.stringify(row)); return true;
  };
  const operationId = randomUUID(), input = {commandIds: ['setsteam', 'view']};
  const result = await f.request('discord', 'register_commands', input, operationId);
  assert.equal(result.data.status, 'succeeded', JSON.stringify(result)); assert.equal(result.data.result.counts.succeeded, 2);
  assert.deepEqual(before.map(([name]) => [name, guild.get(name)]), before);
  assert.deepEqual(f.calls.map(row => row.body.name), ['setsteam', 'view']);
  await f.request('discord', 'register_commands', input, operationId); assert.equal(f.calls.length, 2);
});

test('register all retains other enabled native handlers and target isolation still rejects unassigned commands', async t => {
  const f = await setup(t);
  const result = await f.request('discord', 'register_commands');
  assert.equal(result.data.status, 'succeeded', JSON.stringify(result));
  assert.deepEqual(f.calls.map(row => row.body.name).sort(), ['kda', 'ranking', 'map', 'newwipe', 'setsteam', 'view', 'gather'].sort());
  assert.ok(f.calls.every(row => row.method === 'POST' && row.path.includes('/guilds/100000000000000001/commands')));
  const config = f.service.config('discord');
  f.service.save(f.identity.actorForAccount('admin'), 'discord', {expectedRevision: config.revision,
    config: {targets: [{...config.targets[0], enabledCommandIds: ['setsteam']}]}} , {operationId: randomUUID()});
  const count = f.calls.length, denied = await f.request('discord', 'register_commands', {commandIds: ['view']});
  assert.equal(denied.data.status, 'failed'); assert.equal(f.calls.length, count);
  const selected = await f.request('discord', 'register_commands'); assert.equal(selected.data.status, 'succeeded');
  assert.deepEqual(f.calls.slice(count).map(row => row.body.name), ['setsteam']);
});
