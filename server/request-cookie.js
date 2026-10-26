/** Read one unambiguous cookie without decoding unrelated browser state. */
export function requestCookie(req, name) {
  const matches = String(req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return '';
  try { return decodeURIComponent(matches[0].slice(name.length + 1)); }
  catch { return ''; }
}
