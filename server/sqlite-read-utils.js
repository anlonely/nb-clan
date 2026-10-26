import { normalizeText } from './store.js';
import {
  getSqliteRecord,
  getSqliteRecordsByIds as getSqliteRecordsByIdsBatch,
  getSqliteRecordsByJsonField
} from './storage/repository.js';

export function uniqueNormalizedTexts(values = [], maxLength = 120) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => normalizeText(value, maxLength))
    .filter(Boolean))];
}

export function mergeRecordsById(...sources) {
  const byKey = new Map();
  let fallbackIndex = 0;
  for (const source of sources || []) {
    const records = Array.isArray(source) ? source : [source];
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const id = normalizeText(record.id, 160);
      const key = id || `fallback:${fallbackIndex++}`;
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

export async function getSqliteRecordsByJsonFieldInChunks(collection, field, values = [], options = {}) {
  const normalizedValues = uniqueNormalizedTexts(values, options.maxLength || 160);
  if (!normalizedValues.length) return [];
  const chunkSize = Math.max(1, Math.min(1000, Number(options.chunkSize) || 500));
  const queryOptions = { ...options, limit: options.limit ?? 0 };
  delete queryOptions.chunkSize;
  delete queryOptions.maxLength;
  const chunks = [];
  for (let index = 0; index < normalizedValues.length; index += chunkSize) {
    chunks.push(normalizedValues.slice(index, index + chunkSize));
  }
  const results = await Promise.all(chunks.map((chunk) => (
    getSqliteRecordsByJsonField(collection, field, chunk, queryOptions)
  )));
  return mergeRecordsById(...results);
}

export async function readSqliteRecordsByIds(collection, ids = []) {
  const normalizedIds = uniqueNormalizedTexts(ids, 160);
  if (!normalizedIds.length) return [];
  const results = [];
  for (let index = 0; index < normalizedIds.length; index += 1000) {
    const chunk = await getSqliteRecordsByIdsBatch(collection, normalizedIds.slice(index, index + 1000), { limit: 0 });
    results.push(...chunk);
  }
  return mergeRecordsById(results);
}

export async function getSqliteRecordsByIds(collection, ids = []) {
  const normalizedIds = uniqueNormalizedTexts(ids, 160);
  if (!normalizedIds.length) return [];
  try {
    return await readSqliteRecordsByIds(collection, normalizedIds);
  } catch (error) {
    const records = await Promise.all(normalizedIds.map((id) => getSqliteRecord(collection, id).catch(() => null)));
    return records.filter(Boolean);
  }
}
