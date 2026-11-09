const crypto = require('crypto');

// Local part: dot-separated runs of the characters RFC 5322 allows unquoted.
// Domain: two or more labels that don't start or end with a hyphen, ending in a
// top-level domain of at least two characters that starts with a letter.
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i;

function isValidEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && email.indexOf('@') <= 64
    && EMAIL_RE.test(email);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Strict ISO-8601 date-time with timezone (Z or ±hh:mm).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseIsoDate(v) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normaliseEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

// Stable JSON (sorted keys) so the same body always hashes the same,
// regardless of key order or whitespace in the raw request.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashBody(body) {
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
}

// Opaque cursors: base64url of the last row's sequence number.
function encodeCursor(seq) {
  return Buffer.from(`b:${seq}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^b:(\d{1,18})$/.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

module.exports = {
  isValidEmail, isNonEmptyString, parseIsoDate, normaliseEmail,
  hashBody, encodeCursor, decodeCursor,
};
