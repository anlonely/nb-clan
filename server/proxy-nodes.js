import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const CATALOG_PATH = path.join(DATA_DIR, 'proxy-nodes.json');
const INTERNAL_PROXY_HOST = 'nb-egress';

export function readProxyNodes(filePath = CATALOG_PATH) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw Object.assign(new Error('PROXY_CATALOG_UNAVAILABLE'), { status: 503 });
  }
  const nodes = catalog?.nodes;
  if (catalog?.version !== 1 || !Array.isArray(nodes) || nodes.length > 64) {
    throw Object.assign(new Error('PROXY_CATALOG_INVALID'), { status: 503 });
  }
  const ids = new Set();
  const ports = new Set();
  return nodes.map(node => {
    if (!/^[a-f0-9]{16}$/.test(node?.id) || typeof node.name !== 'string' || !node.name.trim() || node.name.length > 80 ||
        !Number.isInteger(node.port) || node.port < 18000 || node.port > 18063 || ids.has(node.id) || ports.has(node.port)) {
      throw Object.assign(new Error('PROXY_CATALOG_INVALID'), { status: 503 });
    }
    ids.add(node.id);
    ports.add(node.port);
    return { id: node.id, name: node.name, port: node.port };
  });
}

export function selectedProxyUrl(proxy, nodes = readProxyNodes()) {
  if (!proxy?.nodeId) return proxy?.url || '';
  const node = nodes.find(item => item.id === proxy.nodeId);
  if (!node) throw Object.assign(new Error('PROXY_NODE_UNAVAILABLE'), { status: 503 });
  return `http://${INTERNAL_PROXY_HOST}:${node.port}`;
}
