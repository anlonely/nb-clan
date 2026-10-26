import React from 'react';

const formats = {
  t: { hour: 'numeric', minute: '2-digit' },
  T: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  d: { dateStyle: 'short' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
};

function relativeTime(instant) {
  const seconds = (instant - Date.now()) / 1000;
  const [unit, size] = [['year', 31536000], ['month', 2629800], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
    .find(([, scale]) => Math.abs(seconds) >= scale) || ['second', 1];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}

// Display-only: keep the original preview and its approved payload/hash intact.
// React escapes all surrounding text; Discord markup is never treated as HTML.
export function DiscordTimestampText({ children, platform }) {
  if (platform !== 'discord' || typeof children !== 'string') return children;
  const parts = [], segments = children.split(/(```[\s\S]*?(?:```|$)|``[^`]*``|`[^`\n]*`)/g);
  const details = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });
  const zone = details.resolvedOptions().timeZone;
  segments.forEach((segment, segmentIndex) => {
    if (segmentIndex % 2) { parts.push(segment); return; }
    const tokens = /<t:(-?\d{1,16})(?::([tTdDfFR]))?>/g;
    let cursor = 0;
    for (const token of segment.matchAll(tokens)) {
      const instant = Number(token[1]) * 1000, date = new Date(instant);
      if (!Number.isFinite(date.getTime())) continue;
      parts.push(segment.slice(cursor, token.index));
      const style = token[2] || 'f';
      const label = style === 'R' ? relativeTime(instant) : new Intl.DateTimeFormat(undefined, formats[style]).format(date);
      parts.push(<time key={`${segmentIndex}:${token.index}`} dateTime={date.toISOString()} title={`${details.format(date)} (${zone})`}>{label}</time>);
      cursor = token.index + token[0].length;
    }
    parts.push(segment.slice(cursor));
  });
  return <>{parts}</>;
}
