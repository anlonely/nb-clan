/** One relay hash cache. Rotation fences both stale loads and in-flight verification. */
export function createRelayAuthCache({ readHash, verify, ttlMs, now = Date.now }) {
  let generation = 0, cached = null;
  const changed = () => Object.assign(new Error('Relay credentials changed'), { errorCode: 'RELAY_CREDENTIALS_CHANGED', status: 401 });
  const assertCurrent = expected => { if (generation !== expected) throw changed(); };
  async function load(expected) {
    assertCurrent(expected);
    const at = now();
    if (cached && at - cached.loadedAt <= ttlMs) return cached.tokenHash;
    const tokenHash = await readHash();
    assertCurrent(expected);
    cached = { tokenHash, loadedAt: at };
    return tokenHash;
  }
  return Object.freeze({
    invalidate() { generation++; cached = null; },
    async authenticate(request) {
      const expected = generation;
      const tokenHash = await load(expected);
      assertCurrent(expected);
      await verify(request, tokenHash);
      assertCurrent(expected);
      return () => assertCurrent(expected);
    }
  });
}
