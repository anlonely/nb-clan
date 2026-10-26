// rust-go can send a name containing literal JSON Unicode escapes. Decode only
// complete Unicode escapes in display names, leaving IDs and chat text intact.
export function decodeRealtimeName(value) {
  if (typeof value !== 'string' || !value.includes('\\u')) return value;
  return value.replace(/\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][cCdDeEfF][0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})/g, (match, high, low, unit) => {
    if (high && low) return String.fromCharCode(parseInt(high, 16), parseInt(low, 16));
    const code = parseInt(unit, 16);
    return code >= 0xd800 && code <= 0xdfff ? match : String.fromCharCode(code);
  });
}

export function decodedRealtimeNames(record, fields) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fields.includes(key) ? decodeRealtimeName(value) : value]));
}
