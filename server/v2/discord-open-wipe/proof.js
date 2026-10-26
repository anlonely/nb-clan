import { requireValue } from '../identity/errors.js';

// Preserve the original object from the native signature verifier. Data copied
// out of a request, JSON, or a different callback domain cannot gain authority.
const verified = new WeakSet();
export function markOpenWipeProof(proof) {
  requireValue(proof && typeof proof === 'object' && proof.provider === 'discord' && proof.payload?.kind === 'open_wipe', 'PLATFORM_AUTH_INVALID', 401);
  verified.add(proof);
  return proof;
}
export function isOpenWipeProof(proof) { return Boolean(proof && verified.has(proof)); }
export function assertOpenWipeProof(proof) {
  requireValue(isOpenWipeProof(proof) && proof.provider === 'discord' && proof.payload?.kind === 'open_wipe', 'PLATFORM_AUTH_INVALID', 401);
  return proof;
}
