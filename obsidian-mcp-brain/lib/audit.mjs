/**
 * The audit log: one line per event, `AUDIT event=<name> key=value ...`, written to the same
 * stream as the rest of the server's log. A value is printable ASCII, has no spaces and is at
 * most 100 characters, so it cannot add a field or a line. What is logged is decided here:
 * a tool call's target comes from an allowlist of argument names, and nothing else about its
 * arguments (note text, search queries, tokens) is ever written.
 */
import { normalizeAddress } from './uploads.mjs';

/** Longest value written to the log. */
const MAX_VALUE = 100;

/**
 * Makes a value safe to put in an audit line: printable ASCII only, whitespace turned into
 * underscores, cut to 100 characters. An empty value is written as `-`.
 * @param {unknown} v
 * @returns {string}
 */
export function auditValue(v) {
  const s = String(v ?? '').replace(/\s+/g, '_').replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_VALUE);
  return s || '-';
}

/**
 * Builds an audit line, without the timestamp. A field whose value is `undefined` is left out.
 * @param {string} event - A fixed event name chosen by the code, never client text.
 * @param {Record<string, unknown>} fields - Keys are fixed by the code; values are made safe.
 * @returns {string}
 */
export function formatAudit(event, fields = {}) {
  let line = `AUDIT event=${event}`;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line += ` ${key}=${auditValue(value)}`;
  }
  return line;
}

/**
 * The argument names of a tool call that may be logged. A name that is not here is never
 * written, so the list can only grow after a review. Nothing that holds note text or a
 * query is on it.
 */
export const TARGET_ARGS = Object.freeze([
  'vault', 'folder', 'filename', 'newFolder', 'newFilename', 'path', 'tags', 'oldTag', 'newTag',
  'field', 'heading', 'target', 'url', 'permanent', 'size',
]);

/**
 * A URL reduced to what is safe to log: scheme, host and path. The query string, the fragment
 * and any `user:password@` are dropped. A value that is not a URL is written as `-`, because
 * cutting it by hand could leave part of a password in the log.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '-';
  }
}

/**
 * What a tool call touched: its allowlisted arguments, ready for formatAudit. Strings, numbers
 * and booleans are kept, an array of them is joined with commas; anything else is left out.
 * A `url` loses its query string, fragment and credentials.
 * @param {unknown} args - The call's `arguments`.
 * @returns {Record<string, string|number|boolean>}
 */
export function toolTarget(args) {
  const target = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return target;
  for (const key of TARGET_ARGS) {
    let value = args[key];
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) value = value.join(',');
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    target[key] = key === 'url' && typeof value === 'string' ? redactUrl(value) : value;
  }
  return target;
}

/**
 * The host a request named: its `Host` header, or when the connection comes from a trusted
 * proxy, the last entry of `X-Forwarded-Host` (the one the nearest proxy added).
 * @param {{socket?: {remoteAddress?: string}, headers: object}} req
 * @param {{isEmpty: boolean, check: (addr: string) => boolean}|null} trusted - From compileTrustedProxies.
 * @returns {string} '' when the request names no host.
 */
export function requestHost(req, trusted) {
  const peer = normalizeAddress(req.socket?.remoteAddress);
  if (trusted && !trusted.isEmpty && trusted.check(peer)) {
    const forwarded = req.headers['x-forwarded-host'];
    const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    if (typeof raw === 'string' && raw.trim()) return raw.split(',').pop().trim();
  }
  const host = req.headers.host;
  return typeof host === 'string' ? host : '';
}
