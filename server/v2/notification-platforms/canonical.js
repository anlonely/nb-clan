import { createHash } from 'node:crypto';

// g06-parallel/1: never silently drop undefined, non-finite numbers or class instances.
export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object') throw new TypeError('CANONICAL_JSON_INVALID');
    if (ancestors.has(item)) throw new TypeError('CANONICAL_JSON_CYCLE');
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('CANONICAL_JSON_INVALID');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('CANONICAL_JSON_INVALID');
    ancestors.add(item);
    try {
      const keys = Object.keys(item);
      if (array && (keys.length !== item.length || keys.some((key, i) => key !== String(i)))) throw new TypeError('CANONICAL_JSON_INVALID');
      const values = (array ? keys : keys.sort()).map(key => {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !Object.hasOwn(property, 'value')) throw new TypeError('CANONICAL_JSON_INVALID');
        const encoded = encode(property.value);
        return array ? encoded : `${JSON.stringify(key)}:${encoded}`;
      });
      return array ? `[${values.join(',')}]` : `{${values.join(',')}}`;
    } finally { ancestors.delete(item); }
  }
  return encode(value);
}

export const hashPayload = payload => createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
