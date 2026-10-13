/**
 * A small OAuth issuer for tests: it generates an RSA and an EC key pair with node:crypto,
 * serves them as a JWKS document from a local HTTP server, and signs tokens with whatever
 * claims, header and algorithm a test asks for, including deliberately wrong ones.
 */

import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function makeKey(kid, type) {
  const pair = type === 'rsa'
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: type === 'rsa' ? 'RS256' : 'ES256' };
  return { kid, type, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk };
}

/**
 * Starts the issuer on a free loopback port.
 * @returns {Promise<object>} { issuer, jwksUri, audience, sign, claims, rotate, setDown,
 *   setRaw, requests, stop } where `claims()` builds a valid claim set to override.
 */
export async function createIssuer() {
  const state = {
    keys: [makeKey('rsa-1', 'rsa'), makeKey('ec-1', 'ec')],
    down: false,
    raw: null, // a replacement body for the key document
    requests: 0,
  };

  const server = http.createServer((req, res) => {
    state.requests++;
    if (req.url !== '/jwks.json') { res.writeHead(404); return res.end(); }
    if (state.down) { res.writeHead(503); return res.end('down'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(state.raw ?? JSON.stringify({ keys: state.keys.map(k => k.jwk) }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const audience = 'https://mcp.example.test/mcp';

  /** A valid claim set; pass overrides, or `undefined` to remove a claim. */
  const claims = (over = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const c = { iss: base, aud: audience, sub: 'owner', email: 'Owner@Example.test', exp: now + 300, iat: now, ...over };
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    return c;
  };

  /**
   * Signs a token.
   * @param {object} payload
   * @param {object} [opts]
   * @param {string} [opts.kid] - Key to sign with, and the kid put in the header ('rsa-1' by default).
   * @param {string} [opts.alg] - Header alg (the key's own algorithm by default).
   * @param {object} [opts.header] - Extra or replacement header members.
   * @param {boolean} [opts.hmac] - Sign with HMAC-SHA256 using the public key's PEM as the secret.
   * @param {boolean} [opts.none] - Produce an unsigned token.
   * @param {boolean} [opts.der] - Sign an EC key with a DER-encoded signature (what RSA-style verification expects).
   */
  const sign = (payload, { kid = 'rsa-1', alg, header = {}, hmac = false, none = false, der = false } = {}) => {
    const key = state.keys.find(k => k.kid === kid) ?? state.keys[0];
    const algorithm = alg ?? (none ? 'none' : hmac ? 'HS256' : key.type === 'rsa' ? 'RS256' : 'ES256');
    const h = { alg: algorithm, typ: 'JWT', kid, ...header };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const input = `${b64url(h)}.${b64url(payload)}`;
    let sig;
    if (none) sig = Buffer.alloc(0);
    else if (hmac) sig = crypto.createHmac('sha256', key.publicKey.export({ type: 'spki', format: 'pem' })).update(input).digest();
    else if (key.type === 'rsa' || der) sig = crypto.sign('sha256', Buffer.from(input), key.privateKey);
    else sig = crypto.sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${input}.${sig.toString('base64url')}`;
  };

  return {
    issuer: base,
    jwksUri: `${base}/jwks.json`,
    audience,
    claims,
    sign,
    /** Replaces the RSA key with a new one, as an issuer rotating its keys does. */
    rotate(kid = 'rsa-2') {
      state.keys = [makeKey(kid, 'rsa'), state.keys.find(k => k.type === 'ec')];
      return kid;
    },
    /** Adds a key without removing the others. */
    addKey(kid, type = 'ec') { state.keys.push(makeKey(kid, type)); return kid; },
    setDown(down) { state.down = down; },
    setRaw(body) { state.raw = body; },
    get requests() { return state.requests; },
    resetRequests() { state.requests = 0; },
    stop: () => new Promise(r => server.close(r)),
  };
}
