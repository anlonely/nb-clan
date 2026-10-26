import { inflateSync } from 'node:zlib';
import { need, digest } from './model.js';
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = b => { let c = 0xffffffff; for (const byte of b) c = table[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Strict non-animated 8-bit PNG subset. Ancillary metadata is discarded, IDAT is fully inflated under a bound. */
export function validatePng(input, { maxBytes = 1048576, maxDimension = 1024 } = {}) {
  const buffer = Buffer.from(input);
  need(buffer.length > 0 && buffer.length <= maxBytes, 'MEDIA_IMAGE_SIZE', 413);
  need(buffer.subarray(0, 8).equals(signature), 'MEDIA_IMAGE_UNSUPPORTED', 415);
  let offset = 8, header, ended = false, sawIdat = false, idatEnded = false, chunks = 0, palette = 0;
  const data = [], retained = [signature];
  while (offset < buffer.length) {
    need(++chunks <= 4096 && offset + 12 <= buffer.length, 'MEDIA_IMAGE_INVALID', 415);
    const size = buffer.readUInt32BE(offset), end = offset + 12 + size;
    need(size <= maxBytes && end <= buffer.length, 'MEDIA_IMAGE_INVALID', 415);
    const kind = buffer.toString('ascii', offset + 4, offset + 8), body = buffer.subarray(offset + 8, end - 4);
    need(/^[A-Za-z]{4}$/.test(kind) && crc(buffer.subarray(offset + 4, end - 4)) === buffer.readUInt32BE(end - 4), 'MEDIA_IMAGE_INVALID', 415);
    need(header || kind === 'IHDR', 'MEDIA_IMAGE_INVALID', 415);
    if (kind === 'IHDR') {
      need(!header && offset === 8 && size === 13, 'MEDIA_IMAGE_INVALID', 415);
      const width = body.readUInt32BE(0), height = body.readUInt32BE(4), color = body[9], depth = body[8], channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      need(width > 0 && height > 0 && width <= maxDimension && height <= maxDimension, 'MEDIA_IMAGE_DIMENSION', 413);
      need((depth === 8 || color === 3 && [1, 2, 4].includes(depth)) && channels && body[10] === 0 && body[11] === 0 && body[12] === 0, 'MEDIA_IMAGE_UNSUPPORTED', 415);
      header = { width, height, channels, color, depth }; retained.push(buffer.subarray(offset, end));
    } else if (kind === 'PLTE') {
      need(!palette && !sawIdat && size > 0 && size <= 768 && size % 3 === 0 && [2, 3, 6].includes(header.color), 'MEDIA_IMAGE_INVALID', 415);
      palette = size / 3; if (header.color === 3) need(palette <= 2 ** header.depth, 'MEDIA_IMAGE_INVALID', 415);
      retained.push(buffer.subarray(offset, end));
    } else if (kind === 'tRNS') {
      need(!sawIdat && (header.color === 3 && palette && size > 0 && size <= palette || header.color === 0 && size === 2 || header.color === 2 && size === 6), 'MEDIA_IMAGE_INVALID', 415);
      retained.push(buffer.subarray(offset, end));
    } else if (kind === 'IDAT') {
      need(!idatEnded, 'MEDIA_IMAGE_INVALID', 415); sawIdat = true; data.push(body); retained.push(buffer.subarray(offset, end));
    } else if (kind === 'IEND') {
      need(size === 0 && sawIdat && end === buffer.length, 'MEDIA_IMAGE_INVALID', 415);
      ended = true; retained.push(buffer.subarray(offset, end));
    } else {
      if (sawIdat) idatEnded = true;
      need(kind[0] === kind[0].toLowerCase() && !['acTL', 'fcTL', 'fdAT'].includes(kind), 'MEDIA_IMAGE_UNSUPPORTED', 415);
    }
    offset = end;
  }
  need(ended && header && (header.color !== 3 || palette), 'MEDIA_IMAGE_INVALID', 415);
  const stride = Math.ceil(header.width * header.channels * header.depth / 8) + 1, expected = stride * header.height, compressed = Buffer.concat(data);
  let decoded;
  try { decoded = inflateSync(compressed, { maxOutputLength: expected, info: true }); }
  catch { need(false, 'MEDIA_IMAGE_INVALID', 415); }
  need(decoded.buffer.length === expected && decoded.engine.bytesWritten === compressed.length, 'MEDIA_IMAGE_INVALID', 415);
  for (let row = 0; row < header.height; row++) need(decoded.buffer[row * stride] <= 4, 'MEDIA_IMAGE_INVALID', 415);
  const bytes = Buffer.concat(retained);
  return { bytes, contentType: 'image/png', width: header.width, height: header.height, sha256: digest(bytes) };
}
function validateJpeg(buffer, maxDimension) {
  need(buffer.length >= 20 && buffer[0] === 255 && buffer[1] === 216, 'MEDIA_IMAGE_INVALID', 415);
  let offset = 2, width, height, scan = false, ended = false, tables = false;
  const kept = [buffer.subarray(0, 2)];
  while (offset < buffer.length) {
    const start = offset;
    need(buffer[offset++] === 255, 'MEDIA_IMAGE_INVALID', 415);
    while (buffer[offset] === 255) offset++;
    const marker = buffer[offset++];
    if (marker === 217) { need(scan && offset === buffer.length, 'MEDIA_IMAGE_INVALID', 415); ended = true; kept.push(buffer.subarray(start, offset)); break; }
    need(marker !== 0 && marker !== 216 && !(marker >= 208 && marker <= 215) && offset + 2 <= buffer.length, 'MEDIA_IMAGE_INVALID', 415);
    const size = buffer.readUInt16BE(offset), finish = offset + size;
    need(size >= 2 && finish <= buffer.length, 'MEDIA_IMAGE_INVALID', 415);
    if (marker === 192 || marker === 194) {
      need(!width && size >= 11 && buffer[offset + 2] === 8, 'MEDIA_IMAGE_INVALID', 415);
      height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5);
      const channels = buffer[offset + 7]; need([1, 3, 4].includes(channels) && size === 8 + channels * 3, 'MEDIA_IMAGE_INVALID', 415);
      need(width > 0 && height > 0 && width <= maxDimension && height <= maxDimension, 'MEDIA_IMAGE_DIMENSION', 413);
    } else if (marker >= 193 && marker <= 207 && ![194, 196].includes(marker)) need(false, 'MEDIA_IMAGE_UNSUPPORTED', 415);
    if (marker === 219) tables = true;
    if (!(marker >= 224 && marker <= 239) && marker !== 254) kept.push(buffer.subarray(start, finish));
    offset = finish;
    if (marker === 218) {
      need(width && tables && size >= 6, 'MEDIA_IMAGE_INVALID', 415); scan = true;
      const entropy = offset;
      while (offset < buffer.length) {
        if (buffer[offset] !== 255) { offset++; continue; }
        if (buffer[offset + 1] === 0 || buffer[offset + 1] >= 208 && buffer[offset + 1] <= 215) { offset += 2; continue; }
        break;
      }
      need(offset > entropy, 'MEDIA_IMAGE_INVALID', 415); kept.push(buffer.subarray(entropy, offset));
    }
  }
  need(ended && width && scan, 'MEDIA_IMAGE_INVALID', 415);
  return { bytes: Buffer.concat(kept), contentType: 'image/jpeg', width, height };
}
function validateWebp(buffer, maxDimension) {
  need(buffer.length >= 26 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.readUInt32LE(4) + 8 === buffer.length, 'MEDIA_IMAGE_INVALID', 415);
  let offset = 12, width, height, image = false, extended;
  while (offset < buffer.length) {
    need(offset + 8 <= buffer.length, 'MEDIA_IMAGE_INVALID', 415);
    const type = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8, end = start + size;
    need(end + (size % 2) <= buffer.length && !['ANIM', 'ANMF'].includes(type), 'MEDIA_IMAGE_UNSUPPORTED', 415);
    if (type === 'VP8X') {
      need(offset === 12 && size === 10 && !(buffer[start] & 2), 'MEDIA_IMAGE_UNSUPPORTED', 415);
      extended = [buffer.readUIntLE(start + 4, 3) + 1, buffer.readUIntLE(start + 7, 3) + 1];
    } else if (type === 'VP8 ') {
      need(!image && size >= 11 && !(buffer[start] & 1) && buffer.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42])), 'MEDIA_IMAGE_INVALID', 415);
      width = buffer.readUInt16LE(start + 6) & 16383; height = buffer.readUInt16LE(start + 8) & 16383; image = true;
    } else if (type === 'VP8L') {
      need(!image && size > 5 && buffer[start] === 47 && !(buffer[start + 4] & 224), 'MEDIA_IMAGE_INVALID', 415);
      const bits = buffer.readUInt32LE(start + 1); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; image = true;
    } else need(['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type), 'MEDIA_IMAGE_UNSUPPORTED', 415);
    offset = end + (size % 2);
  }
  need(image && width > 0 && height > 0 && (!extended || width === extended[0] && height === extended[1]), 'MEDIA_IMAGE_INVALID', 415);
  need(width <= maxDimension && height <= maxDimension, 'MEDIA_IMAGE_DIMENSION', 413);
  return { bytes: buffer, contentType: 'image/webp', width, height };
}
export function validateImage(input, { maxBytes = 1048576, maxDimension = 1024 } = {}) {
  const buffer = Buffer.from(input); need(buffer.length > 0 && buffer.length <= maxBytes, 'MEDIA_IMAGE_SIZE', 413);
  if (buffer.subarray(0, 8).equals(signature)) return validatePng(buffer, { maxBytes, maxDimension });
  const result = buffer[0] === 255 && buffer[1] === 216 ? validateJpeg(buffer, maxDimension) :
    buffer.toString('ascii', 0, 4) === 'RIFF' ? validateWebp(buffer, maxDimension) : null;
  need(result, 'MEDIA_IMAGE_UNSUPPORTED', 415); return { ...result, sha256: digest(result.bytes) };
}
export function decodeAvatar(input) {
  need(typeof input === 'string' && input.length <= 1400000, 'MEDIA_IMAGE_SIZE', 413);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  need(match && match[2].length % 4 === 0, 'MEDIA_IMAGE_UNSUPPORTED', 415);
  const bytes = Buffer.from(match[2], 'base64');
  need(bytes.toString('base64') === match[2], 'MEDIA_IMAGE_INVALID', 415);
  const image = validateImage(bytes); need(image.contentType === match[1], 'MEDIA_IMAGE_TYPE_MISMATCH', 415);
  return { ...image, inputSha256: digest(bytes) };
}
export async function readImage(response, signal, { maxBytes = 2097152, maxDimension = 2048 } = {}) {
  try {
  signal.throwIfAborted();
  need(response?.status === 200, 'MEDIA_FETCH_FAILED', 502);
  const type = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase().trim();
  need(['image/png', 'image/jpeg', 'image/webp'].includes(type), 'MEDIA_IMAGE_UNSUPPORTED', 415);
  const declared = response.headers?.get?.('content-length');
  need(declared == null || /^\d+$/.test(declared) && Number(declared) <= maxBytes, 'MEDIA_IMAGE_SIZE', 413);
  need(response.body?.[Symbol.asyncIterator], 'MEDIA_BODY_REQUIRED', 502);
  const chunks = []; let length = 0;
    for await (const part of response.body) {
      signal.throwIfAborted(); const chunk = Buffer.from(part); length += chunk.length;
      need(length <= maxBytes, 'MEDIA_IMAGE_SIZE', 413); chunks.push(chunk);
    }
    signal.throwIfAborted(); const image = validateImage(Buffer.concat(chunks, length), { maxBytes, maxDimension });
    need(image.contentType === type, 'MEDIA_IMAGE_TYPE_MISMATCH', 415); return image;
  } finally { await response?.dispose?.(); }
}
