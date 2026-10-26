import assert from 'node:assert/strict';
import test from 'node:test';
import { vitalServersForStore } from '../server/api.js';
import { parseVitalServerCatalog } from '../server/rust-kda-provider.js';

const catalogPayload = {
  data: [
    {
      id: 23,
      displayName: 'US Monthly',
      battlemetricsServerId: '36933209',
      connectionHost: '203.0.113.23',
      connectionPort: 28014
    }
  ]
};

test('Vital official catalog refreshes direct-connect data while settings overrides remain authoritative', () => {
  const catalog = parseVitalServerCatalog(catalogPayload);
  const defaultStore = { settings: { vitalServers: { overrides: [] } } };
  const fromCatalog = vitalServersForStore(defaultStore, catalog)
    .find((server) => server.vitalServerId === '23');
  assert.equal(fromCatalog.directConnect, 'client.connect 203.0.113.23:28014');
  assert.equal(fromCatalog.status, 'hidden');

  const overriddenStore = {
    settings: {
      vitalServers: {
        overrides: [{
          vitalServerId: '23',
          directConnect: 'client.connect custom.example:28014',
          status: 'active'
        }]
      }
    }
  };
  const overridden = vitalServersForStore(overriddenStore, catalog)
    .find((server) => server.vitalServerId === '23');
  assert.equal(overridden.directConnect, 'client.connect custom.example:28014');
  assert.equal(overridden.status, 'active');
});

test('Vital catalog rejects unsafe or unusable connection fields', () => {
  const catalog = parseVitalServerCatalog({
    data: [
      { id: 4, connectionHost: 'bad host;command', connectionPort: 28014 },
      { id: 16, connectionHost: '198.51.100.16', connectionPort: 0 },
      { id: 'not-an-id', connectionHost: '198.51.100.17', connectionPort: 28014 }
    ]
  });
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].connectionHost, '');
  assert.equal(catalog[1].connectionPort, 0);
});
