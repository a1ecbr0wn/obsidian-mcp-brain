// Resource server mode: checking the access tokens an external OAuth authorization server
// issues. This server issues no tokens and holds no credentials. Everything here is pure or
// takes its collaborators (the clock, `fetch`) as arguments, so it is unit-testable without
// a running server. Only node:crypto and the global fetch are used.

import crypto from 'node:crypto';

/** Token signing algorithms accepted. Taken from this fixed list, never from the key. */
export const SUPPORTED_ALGS = ['RS256', 'ES256'];

/** A token longer than this is treated as not being a token. */
export const MAX_TOKEN_BYTES = 8192;

const MAX_JWKS_BYTES = 64 * 1024;
const MIN_RSA_BITS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Fields of the `auth` configuration object. */
const AUTH_FIELDS = new Set(['issuer', 'jwksUri', 'audience', 'userClaim', 'users', 'readOnlyUsers', 'tokenHeader']);

// ── tool roles ──────────────────────────────────────────────────────────────

/**
 * What each tool needs. `read` tools only read the vault; `write` tools change it or reserve
 * a write; `unrestricted` tools are for users who are not read-only because they do not
 * apply every protection a read-only user is meant to be held to (query-graph answers from
 * the whole vault without applying denyPaths). A tool that is not listed is treated as a
 * write tool, so a new tool is refused to read-only users until it is classified here.
 */
export const TOOL_ROLES = Object.freeze({
  'list-notes': 'read',
  'list-tags': 'read',
  'search-tags': 'read',
  'new-notes': 'read',
  'changed-notes': 'read',
  'list-vaults': 'read',
  'read-note': 'read',
  'read-binary-file': 'read',
  'find-backlinks': 'read',
  'resolve-wikilink': 'read',
  'search-vault': 'read',
  'create-note': 'write',
  'edit-note': 'write',
  'delete-note': 'write',
  'move-note': 'write',
  'create-binary-file': 'write',
  'fetch-binary-file': 'write',
  'upload-binary-file': 'write',
  'move-binary-file': 'write',
  'delete-binary-file': 'write',
  'create-folder': 'write',
  'add-tags': 'write',
  'remove-tags': 'write',
  'rename-tag': 'write',
  'set-frontmatter-field': 'write',
  'remove-frontmatter-field': 'write',
  'query-graph': 'unrestricted',
});

/**
 * Whether a user with the given role may call a tool.
 * @param {'full'|'readonly'} role
 * @param {string} toolName
 * @returns {boolean}
 */
export function toolAllowed(role, toolName) {
  if (role === 'full') return true;
  // Own properties only, so a name such as "__proto__" or "constructor" cannot match.
  return typeof toolName === 'string' && Object.hasOwn(TOOL_ROLES, toolName) && TOOL_ROLES[toolName] === 'read';
}

// ── configuration ───────────────────────────────────────────────────────────

const isLoopbackUrl = (u) => LOOPBACK_HOSTS.has(u.hostname.toLowerCase());

function checkUrl(value, field, { allowLoopbackHttp = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"auth.${field}" must be a non-empty string`);
  let u;
  try { u = new URL(value); } catch { throw new Error(`"auth.${field}" must be an absolute URL`); }
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && isLoopbackUrl(u))) {
    throw new Error(`"auth.${field}" must be an https URL (http is allowed only for a loopback host)`);
  }
  if (u.username || u.password) throw new Error(`"auth.${field}" must not contain a user name or password`);
  return value;
}

/**
 * Folds an email address for comparison. Only ASCII letters are folded: full Unicode case
 * folding maps some other characters onto ASCII ones (the Kelvin sign onto "k"), which would
 * let a different address match a configured one.
 * @param {string} s
 * @returns {string}
 */
const foldEmail = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Validates the `auth` object from the configuration file.
 * @param {*} raw - The value of the `auth` field (not undefined).
 * @param {string} mcpBaseUrl - The configured public URL of this server.
 * @param {string} [listenHost] - The address the server listens on.
 * @returns {{issuer: string, jwksUri: string, audience: string, userClaim: string,
 *   users: Set<string>, readOnlyUsers: Set<string>, tokenHeader: (string|null)}}
 * @throws {Error} naming the field, when the object is not usable or is not safe.
 */
export function parseAuthConfig(raw, mcpBaseUrl, listenHost = '127.0.0.1') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"auth" must be an object');
  for (const key of Object.keys(raw)) {
    if (!AUTH_FIELDS.has(key)) throw new Error(`"auth.${key}" is not a known setting`);
  }

  let base;
  try { base = new URL(mcpBaseUrl); } catch { throw new Error('"mcpBaseUrl" must be an absolute URL when "auth" is set'); }
  if (base.protocol !== 'https:' && !isLoopbackUrl(base)) {
    throw new Error('"mcpBaseUrl" must be an https URL when "auth" is set (http is allowed only for a loopback host)');
  }
  // An http address is allowed only because a loopback listener cannot be reached from the
  // network. Listening on every interface would send bearer tokens across it in clear.
  if (base.protocol !== 'https:' && !LOOPBACK_HOSTS.has(String(listenHost).trim().toLowerCase())) {
    throw new Error('"listenHost" must be a loopback address when "auth" is set and "mcpBaseUrl" is not https');
  }

  const issuer = checkUrl(raw.issuer, 'issuer');
  const jwksUri = checkUrl(raw.jwksUri, 'jwksUri');

  const audience = raw.audience === undefined ? `${String(mcpBaseUrl).replace(/\/+$/, '')}/mcp` : raw.audience;
  if (typeof audience !== 'string' || !audience.trim()) throw new Error('"auth.audience" must be a non-empty string');

  const userClaim = raw.userClaim === undefined ? 'sub' : raw.userClaim;
  if (typeof userClaim !== 'string' || !userClaim.trim()) throw new Error('"auth.userClaim" must be a non-empty string');

  const normalise = (s) => (userClaim === 'email' ? foldEmail(s) : s);
  const list = (value, field, { required }) => {
    if (value === undefined && !required) return new Set();
    if (!Array.isArray(value) || value.some(u => typeof u !== 'string' || !u.trim())) {
      throw new Error(`"auth.${field}" must be an array of non-empty strings`);
    }
    if (required && value.length === 0) throw new Error(`"auth.${field}" must list at least one user`);
    return new Set(value.map(u => normalise(u.trim())));
  };
  const users = list(raw.users, 'users', { required: true });
  const readOnlyUsers = list(raw.readOnlyUsers, 'readOnlyUsers', { required: false });
  for (const u of readOnlyUsers) {
    if (users.has(u)) throw new Error(`"auth.readOnlyUsers" lists "${u}", who is also in "auth.users"`);
  }

  let tokenHeader = null;
  if (raw.tokenHeader !== undefined && raw.tokenHeader !== null) {
    if (typeof raw.tokenHeader !== 'string' || !/^[A-Za-z0-9-]+$/.test(raw.tokenHeader)) {
      throw new Error('"auth.tokenHeader" must be a header name, or null');
    }
    tokenHeader = raw.tokenHeader.toLowerCase();
  }

  return { issuer, jwksUri, audience, userClaim, users, readOnlyUsers, tokenHeader };
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * A refusal with a reason class that is safe to log, and the HTTP status to answer with.
 * `user` is set only when the token's signature was verified, so it can be trusted.
 */
export class AuthError extends Error {
  /**
   * @param {string} reason - One of: no token, malformed, unsupported algorithm, unknown key,
   *   bad signature, expired, not yet valid, wrong issuer, wrong audience, missing user claim,
   *   email not verified, user not allowed, keys unavailable.
   * @param {number} [status] - 401 unless stated.
   * @param {string} [user]
   */
  constructor(reason, status = 401, user) {
    super(reason);
    this.reason = reason;
    this.status = status;
    this.user = user;
  }
}

const b64urlDecode = (s) => Buffer.from(s, 'base64url');

function parseJsonPart(part) {
  try {
    const v = JSON.parse(b64urlDecode(part).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Splits and decodes a compact JWS. Does not verify anything.
 * @param {string} token
 * @returns {{header: object, payload: object, signingInput: Buffer, signature: Buffer}}
 * @throws {AuthError} malformed
 */
export function parseToken(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) throw new AuthError('malformed');
  const parts = token.split('.');
  // The signature part may be empty: an unsigned token has one, and it is refused for its
  // algorithm, not as malformed.
  if (parts.length !== 3 || !parts[0] || !parts[1] || !B64URL.test(parts[0]) || !B64URL.test(parts[1])
      || (parts[2] && !B64URL.test(parts[2]))) throw new AuthError('malformed');
  const header = parseJsonPart(parts[0]);
  const payload = parseJsonPart(parts[1]);
  if (!header || !payload) throw new AuthError('malformed');
  return {
    header,
    payload,
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    signature: b64urlDecode(parts[2]),
  };
}

/**
 * The issuer's public signing keys, fetched from its JWKS endpoint and cached by `kid`.
 * The key set is refetched when an unknown `kid` arrives (at most once a minute) and
 * refreshed in the background once it is an hour old. A fetch that fails leaves the keys
 * already held in use. A successful fetch replaces the set, so a key the issuer has
 * withdrawn stops being accepted.
 */
export class KeyStore {
  #jwksUri;
  #fetch;
  #now;
  #timeoutMs;
  #minRefetchMs;
  #refreshMs;
  #keys = new Map(); // kid → KeyObject
  #fetchedAt = 0;
  #attemptedAt = -Infinity;
  #lastError = null;
  #inflight = null;

  /**
   * @param {object} opts
   * @param {string} opts.jwksUri
   * @param {function} [opts.fetchImpl] - fetch-compatible function.
   * @param {function} [opts.now] - Returns the time in ms.
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.minRefetchMs] - Shortest gap between fetches triggered by an unknown kid.
   * @param {number} [opts.refreshMs] - Age after which the set is refreshed in the background.
   */
  constructor({ jwksUri, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000, minRefetchMs = 60_000, refreshMs = 3_600_000 }) {
    this.#jwksUri = jwksUri;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#minRefetchMs = minRefetchMs;
    this.#refreshMs = refreshMs;
  }

  /** Number of keys currently held. */
  get size() { return this.#keys.size; }

  async #download() {
    const res = await this.#fetch(this.#jwksUri, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`key endpoint answered ${res.status}`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (declared > MAX_JWKS_BYTES) throw new Error('key document too large');
    const reader = res.body?.getReader?.();
    let text;
    if (reader) {
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_JWKS_BYTES) { await reader.cancel().catch(() => {}); throw new Error('key document too large'); }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await res.text();
      if (text.length > MAX_JWKS_BYTES) throw new Error('key document too large');
    }
    const doc = JSON.parse(text);
    if (!doc || !Array.isArray(doc.keys)) throw new Error('key document has no "keys" array');
    const keys = new Map();
    for (const jwk of doc.keys) {
      if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid) continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      try {
        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) continue;
        if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') continue;
        if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ec') continue;
        keys.set(jwk.kid, key);
      } catch { /* a key that cannot be imported is not usable */ }
    }
    // A document with no usable key is a fault at the issuer, not a withdrawal of every key:
    // keep what is held, so one bad document does not sign everyone out.
    if (keys.size === 0) throw new Error('key document has no usable key');
    return keys;
  }

  /** Fetches the key set once at a time. Resolves true when it succeeded. */
  #refresh() {
    if (this.#inflight) return this.#inflight;
    this.#attemptedAt = this.#now();
    this.#inflight = this.#download()
      .then((keys) => { this.#keys = keys; this.#fetchedAt = this.#now(); this.#lastError = null; return true; })
      .catch((err) => { this.#lastError = err; return false; })
      .finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  /**
   * Fetches the keys now, for a start-up check.
   * @returns {Promise<boolean>} Whether the key endpoint could be read.
   */
  prefetch() { return this.#refresh(); }

  /** The last fetch error, if the most recent fetch failed. */
  get lastError() { return this.#lastError; }

  /**
   * Finds the key a token names.
   * @param {string} kid
   * @returns {Promise<crypto.KeyObject>}
   * @throws {AuthError} unknown key (401), or keys unavailable (503) when they cannot be fetched.
   */
  async getKey(kid) {
    const held = this.#keys.get(kid);
    if (held) {
      const stale = this.#now() - this.#fetchedAt > this.#refreshMs;
      // Obeys the same gap as an unknown kid, so an issuer that is down is not hammered.
      if (stale && !this.#inflight && this.#now() - this.#attemptedAt >= this.#minRefetchMs) this.#refresh();
      return held;
    }
    // An unknown kid may be a key the issuer has just added, so look again, but not more
    // often than the limit: a stream of made-up kids must not become a stream of fetches.
    if (this.#inflight || this.#now() - this.#attemptedAt >= this.#minRefetchMs) {
      await this.#refresh();
      const found = this.#keys.get(kid);
      if (found) return found;
    }
    // If the keys could not be read, the kid may well be in them: that is the server's
    // problem and not the client's, so it is not reported as an unknown key.
    if (this.#lastError) throw new AuthError('keys unavailable', 503);
    throw new AuthError('unknown key');
  }
}

/** What the user claim of a verified token resolves to under the configuration. */
function normaliseUser(cfg, value) {
  return cfg.userClaim === 'email' ? foldEmail(value) : value;
}

/**
 * Which role a user has under the configuration.
 * @param {object} cfg - Result of parseAuthConfig.
 * @param {string} user - The user claim value.
 * @returns {'full'|'readonly'|null}
 */
export function userRole(cfg, user) {
  const u = normaliseUser(cfg, user);
  if (cfg.users.has(u)) return 'full';
  if (cfg.readOnlyUsers.has(u)) return 'readonly';
  return null;
}

/**
 * Verifies an access token: structure, algorithm, signature, then claims, then the user.
 * @param {string} token
 * @param {object} cfg - Result of parseAuthConfig.
 * @param {KeyStore} keys
 * @param {object} [opts]
 * @param {number} [opts.nowMs] - Current time in ms.
 * @param {number} [opts.leewaySeconds] - Clock skew allowed on exp and nbf.
 * @returns {Promise<{user: string, role: 'full'|'readonly', claims: object}>}
 * @throws {AuthError}
 */
export async function verifyAccessToken(token, cfg, keys, { nowMs = Date.now(), leewaySeconds = 60 } = {}) {
  const { header, payload, signingInput, signature } = parseToken(token);

  if (!SUPPORTED_ALGS.includes(header.alg)) throw new AuthError('unsupported algorithm');
  if (header.crit !== undefined) throw new AuthError('malformed');
  if (typeof header.kid !== 'string' || !header.kid) throw new AuthError('unknown key');

  const key = await keys.getKey(header.kid);

  let valid = false;
  if (header.alg === 'RS256' && key.asymmetricKeyType === 'rsa') {
    valid = crypto.verify('sha256', signingInput, key, signature);
  } else if (header.alg === 'ES256' && key.asymmetricKeyType === 'ec' && signature.length === 64) {
    valid = crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  if (!valid) throw new AuthError('bad signature');

  // From here the claims are authentic, so the user can be named in the log.
  const user = typeof payload[cfg.userClaim] === 'string' ? payload[cfg.userClaim].trim() : '';
  const fail = (reason, status = 401) => new AuthError(reason, status, user || undefined);

  if (payload.iss !== cfg.issuer) throw fail('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.audience)) throw fail('wrong audience');

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw fail('malformed');
  if (payload.exp + leewaySeconds <= nowSec) throw fail('expired');
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) throw fail('malformed');
    if (payload.nbf - leewaySeconds > nowSec) throw fail('not yet valid');
  }

  if (!user) throw fail('missing user claim');
  // An address the issuer has not verified could belong to anyone who registered it there.
  if (cfg.userClaim === 'email' && (payload.email_verified === false || payload.email_verified === 'false')) {
    throw fail('email not verified', 403);
  }
  const role = userRole(cfg, user);
  if (!role) throw fail('user not allowed', 403);
  return { user, role, claims: payload };
}

/**
 * Reads the token from a request: `Authorization: Bearer <token>` first, then the configured
 * header. Whatever is not a single, plausible token is reported as no token.
 * @param {object} headers - Node's lower-cased request headers.
 * @param {object} cfg - Result of parseAuthConfig.
 * @returns {string|null}
 */
export function extractToken(headers, cfg) {
  const candidates = [];
  const authz = headers.authorization;
  if (typeof authz === 'string') {
    const m = authz.match(/^Bearer\s+(\S+)$/i);
    if (m) candidates.push(m[1]);
  }
  if (cfg.tokenHeader) {
    const raw = headers[cfg.tokenHeader];
    if (typeof raw === 'string') {
      const v = raw.trim().replace(/^Bearer\s+/i, '');
      if (v && !/\s/.test(v)) candidates.push(v);
    }
  }
  return candidates.find(t => t.length <= MAX_TOKEN_BYTES) ?? null;
}
