import {requireValue} from '../identity/errors.js';
// Only original objects returned by the native bytes verifier are eligible for
// the internal callback handoff. JSON, spread copies and structuredClone fail.
const verified=new WeakSet();
export function markCommunityProof(proof){verified.add(proof);return proof;}
export function isCommunityProof(proof){return Boolean(proof&&verified.has(proof));}
export function assertCommunityProof(proof,platform){requireValue(isCommunityProof(proof)&&proof.provider===platform&&proof.payload?.kind==='community','PLATFORM_AUTH_INVALID',401);return proof;}
