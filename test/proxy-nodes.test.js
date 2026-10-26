import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProxyNodes, selectedProxyUrl } from '../server/proxy-nodes.js';

test('catalog exposes only sanitized node metadata and rejects ambiguous ports', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'nodes.json');
  const nodes = [{ id: '1234567890abcdef', name: 'First node', port: 18000 }];
  fs.writeFileSync(filename, JSON.stringify({ version: 1, nodes }));
  assert.deepEqual(readProxyNodes(filename), nodes);
  assert.equal(selectedProxyUrl({ nodeId: nodes[0].id }, readProxyNodes(filename)), 'http://nb-egress:18000');
  assert.throws(() => selectedProxyUrl({ nodeId: '0000000000000000' }, nodes), /PROXY_NODE_UNAVAILABLE/);
  fs.writeFileSync(filename, JSON.stringify({ version: 1, nodes: [...nodes, { id: '0000000000000000', name: 'Duplicate port', port: 18000 }] }));
  assert.throws(() => readProxyNodes(filename), /PROXY_CATALOG_INVALID/);
});
