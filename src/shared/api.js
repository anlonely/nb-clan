export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || '请求失败');
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('Retry-After') || payload.retryAfter || 0);
    throw error;
  }
  return payload;
}
