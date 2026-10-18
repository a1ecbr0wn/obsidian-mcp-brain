/**
 * Unit tests for lib/auth.mjs: the `auth` configuration object, reading a token from a
 * request, verifying it against an issuer's keys, and the tool roles. The issuer is a real
 * local HTTP server (test/helpers/issuer.mjs), so key fetching is exercised too.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  parseAuthConfig, KeyStore, verifyAccessToken, extractToken, toolAllowed, userRole,
  TOOL_ROLES, MAX_TOKEN_BYTES, AuthError,
} from '../lib/auth.mjs';
import { createIssuer } from './helpers/issuer.mjs';

const BASE = 'https://mcp.example.test';
const good = (over = {}) => ({
  issuer: 'https://auth.example.test',
  jwksUri: 'https://auth.example.test/jwks.json',
  users: ['owner'],
  ...over,
});
const rejects = (raw, base, message, listenHost) => assert.throws(() => parseAuthConfig(raw, base ?? BASE, listenHost), (e) => {
  assert.ok(e.message.includes(message), `expected "${message}" in "${e.message}"`);
  return true;
});

describe('parseAuthConfig', () => {
  it('accepts a minimal object and fills in the defaults', () => {
    const c = parseAuthConfig(good(), BASE);
    assert.equal(c.audience, `${BASE}/mcp`);
    assert.equal(c.userClaim, 'sub');
    assert.equal(c.tokenHeader, null);
    assert.deepEqual([...c.users], ['owner']);
    assert.equal(c.readOnlyUsers.size, 0);
  });

  it('builds the default audience without a doubled slash', () => {
    assert.equal(parseAuthConfig(good(), `${BASE}/`).audience, `${BASE}/mcp`);
  });

  it('lower-cases users, and the claim value, when the claim is email', () => {
    const c = parseAuthConfig(good({ userClaim: 'email', users: ['Owner@Example.test'] }), BASE);
    assert.ok(c.users.has('owner@example.test'));
    assert.equal(userRole(c, 'OWNER@example.TEST'), 'full');
  });

  it('keeps case for any other claim', () => {
    const c = parseAuthConfig(good({ users: ['Owner'] }), BASE);
    assert.equal(userRole(c, 'Owner'), 'full');
    assert.equal(userRole(c, 'owner'), null);
  });

  it('accepts a header name and lower-cases it', () => {
    assert.equal(parseAuthConfig(good({ tokenHeader: 'X-Forwarded-Token' }), BASE).tokenHeader, 'x-forwarded-token');
  });

  for (const bad of [null, 'yes', ['a'], 5]) {
    it(`rejects ${JSON.stringify(bad)} as the auth object`, () => rejects(bad, BASE, '"auth" must be an object'));
  }

  it('rejects an unknown setting, so a misspelling is not silently ignored', () => {
    rejects(good({ user: ['a'] }), BASE, '"auth.user" is not a known setting');
  });

  for (const field of ['issuer', 'jwksUri']) {
    it(`rejects a missing ${field}`, () => rejects(good({ [field]: undefined }), BASE, `"auth.${field}"`));
    it(`rejects a ${field} that is not a URL`, () => rejects(good({ [field]: 'nonsense' }), BASE, `"auth.${field}" must be an absolute URL`));
    it(`rejects a plain http ${field} on a host that is not loopback`, () => {
      rejects(good({ [field]: 'http://auth.example.test/x' }), BASE, `"auth.${field}" must be an https URL`);
    });
    it(`allows a plain http ${field} on loopback`, () => {
      assert.ok(parseAuthConfig(good({ [field]: 'http://127.0.0.1:9/x' }), BASE));
    });
  }

  for (const bad of [undefined, [], 'owner', [''], [1], [' ']]) {
    it(`rejects users ${JSON.stringify(bad)}`, () => rejects(good({ users: bad }), BASE, '"auth.users"'));
  }

  it('rejects readOnlyUsers that is not an array of strings', () => {
    rejects(good({ readOnlyUsers: 'x' }), BASE, '"auth.readOnlyUsers"');
  });

  it('rejects a user in both lists', () => {
    rejects(good({ readOnlyUsers: ['owner'] }), BASE, 'also in "auth.users"');
  });

  it('rejects a user in both lists when they differ only in case and the claim is email', () => {
    rejects(good({ userClaim: 'email', users: ['A@x.test'], readOnlyUsers: ['a@X.test'] }), BASE, 'also in "auth.users"');
  });

  it('rejects credentials in the issuer or key endpoint URL, which would reach the log', () => {
    rejects(good({ issuer: 'https://user:pw@auth.example.test' }), BASE, 'must not contain a user name or password');
    rejects(good({ jwksUri: 'https://user@auth.example.test/jwks' }), BASE, 'must not contain a user name or password');
  });

  it('rejects an http mcpBaseUrl when the server listens on a non-loopback address', () => {
    assert.ok(parseAuthConfig(good(), 'http://127.0.0.1:3002', '127.0.0.1'));
    assert.ok(parseAuthConfig(good(), 'http://127.0.0.1:3002', '::1'));
    rejects(good(), 'http://127.0.0.1:3002', '"listenHost" must be a loopback address', '0.0.0.0');
    assert.ok(parseAuthConfig(good(), BASE, '0.0.0.0'), 'an https mcpBaseUrl may listen anywhere');
  });

  it('rejects an mcpBaseUrl that is plain http on a host that is not loopback', () => {
    rejects(good(), 'http://mcp.example.test', '"mcpBaseUrl" must be an https URL');
  });

  it('allows a plain http mcpBaseUrl on loopback', () => {
    assert.ok(parseAuthConfig(good(), 'http://127.0.0.1:3002'));
    assert.ok(parseAuthConfig(good(), 'http://localhost:3002'));
  });

  for (const bad of ['', 5, 'bad header', 'a:b']) {
    it(`rejects tokenHeader ${JSON.stringify(bad)}`, () => rejects(good({ tokenHeader: bad }), BASE, '"auth.tokenHeader"'));
  }

  it('rejects an empty userClaim and an empty audience', () => {
    rejects(good({ userClaim: '' }), BASE, '"auth.userClaim"');
    rejects(good({ audience: '' }), BASE, '"auth.audience"');
  });
});

describe('tool roles', () => {
  it('a full user may call anything', () => {
    for (const name of [...Object.keys(TOOL_ROLES), 'a-tool-added-later']) assert.equal(toolAllowed('full', name), true, name);
  });

  it('a read-only user may call the read tools and nothing else', () => {
    for (const [name, role] of Object.entries(TOOL_ROLES)) {
      assert.equal(toolAllowed('readonly', name), role === 'read', name);
    }
  });

  it('a name that is not a plain tool name is refused to a read-only user', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'List-Notes', ' list-notes', 'list-notes ', ['list-notes'], { toString: () => 'list-notes' }, 5, null]) {
      assert.equal(toolAllowed('readonly', name), false, String(name));
    }
  });

  it('a tool that is not classified is refused to a read-only user', () => {
    assert.equal(toolAllowed('readonly', 'a-tool-added-later'), false);
    assert.equal(toolAllowed('readonly', undefined), false);
  });

  it('query-graph and every tool that changes the vault are not read tools', () => {
    for (const name of ['query-graph', 'create-note', 'edit-note', 'upload-binary-file', 'replace-binary-file', 'fetch-binary-file', 'move-note', 'delete-binary-file']) {
      assert.equal(toolAllowed('readonly', name), false, name);
    }
  });
});

describe('extractToken', () => {
  const cfg = parseAuthConfig(good({ tokenHeader: 'x-token' }), BASE);
  const plain = parseAuthConfig(good(), BASE);

  it('reads a Bearer token, whatever the case of the scheme', () => {
    assert.equal(extractToken({ authorization: 'Bearer abc.def.ghi' }, plain), 'abc.def.ghi');
    assert.equal(extractToken({ authorization: 'bearer abc' }, plain), 'abc');
  });

  it('returns null for no header, another scheme, or more than one word', () => {
    assert.equal(extractToken({}, plain), null);
    assert.equal(extractToken({ authorization: 'Basic abc' }, plain), null);
    assert.equal(extractToken({ authorization: 'Bearer a b' }, plain), null);
  });

  it('reads the configured header, with or without a Bearer prefix, and prefers it to Authorization', () => {
    assert.equal(extractToken({ 'x-token': 'raw' }, cfg), 'raw');
    assert.equal(extractToken({ 'x-token': 'Bearer raw' }, cfg), 'raw');
    assert.equal(extractToken({ authorization: 'Bearer first', 'x-token': 'second' }, cfg), 'second');
    assert.equal(extractToken({ authorization: 'Bearer first' }, cfg), 'first');
  });

  it('does not read the configured header when none is configured', () => {
    assert.equal(extractToken({ 'x-token': 'raw' }, plain), null);
  });

  it('treats a token over the size limit as no token', () => {
    assert.equal(extractToken({ authorization: `Bearer ${'a'.repeat(MAX_TOKEN_BYTES + 1)}` }, plain), null);
  });
});

describe('verifyAccessToken', () => {
  let iss;
  let cfg;
  let keys;
  before(async () => {
    iss = await createIssuer();
    cfg = parseAuthConfig({
      issuer: iss.issuer, jwksUri: iss.jwksUri, audience: iss.audience,
      userClaim: 'email', users: ['owner@example.test'], readOnlyUsers: ['viewer@example.test'],
    }, 'https://mcp.example.test');
    keys = new KeyStore({ jwksUri: iss.jwksUri });
  });
  after(async () => { await iss.stop(); });

  const verify = (token, opts) => verifyAccessToken(token, cfg, keys, opts);
  const refusal = async (token, reason, status = 401, opts) => {
    await assert.rejects(verify(token, opts), (e) => {
      assert.ok(e instanceof AuthError, String(e));
      assert.equal(e.reason, reason);
      assert.equal(e.status, status);
      return true;
    });
  };

  it('accepts a valid RS256 token', async () => {
    const r = await verify(iss.sign(iss.claims()));
    assert.equal(r.user, 'Owner@Example.test');
    assert.equal(r.role, 'full');
  });

  it('accepts a valid ES256 token', async () => {
    assert.equal((await verify(iss.sign(iss.claims(), { kid: 'ec-1' }))).role, 'full');
  });

  it('gives a read-only user the readonly role', async () => {
    assert.equal((await verify(iss.sign(iss.claims({ email: 'viewer@example.test' })))).role, 'readonly');
  });

  it('accepts an audience given as an array that contains the configured one', async () => {
    assert.ok(await verify(iss.sign(iss.claims({ aud: ['other', iss.audience] }))));
  });

  it('refuses a token signed by a different key than its kid names', async () => {
    const t = iss.sign(iss.claims(), { kid: 'ec-1', header: { kid: 'rsa-1', alg: 'RS256' } });
    await refusal(t, 'bad signature');
  });

  it('refuses a token whose payload was changed after signing', async () => {
    const [h, , s] = iss.sign(iss.claims()).split('.');
    const forged = Buffer.from(JSON.stringify(iss.claims({ email: 'owner@example.test', sub: 'attacker' }))).toString('base64url');
    await refusal(`${h}.${forged}.${s}`, 'bad signature');
  });

  it('refuses an RS256 header on an EC key and the reverse', async () => {
    await refusal(iss.sign(iss.claims(), { kid: 'ec-1', alg: 'RS256' }), 'bad signature');
    await refusal(iss.sign(iss.claims(), { kid: 'rsa-1', alg: 'ES256' }), 'bad signature');
  });

  it('refuses an RS256 header on an EC key even when the signature would verify as DER', async () => {
    // Without the key-type guard, crypto.verify would accept this: the signature is a valid
    // DER ECDSA signature by the EC key. Only the check on the key's type refuses it.
    await refusal(iss.sign(iss.claims(), { kid: 'ec-1', alg: 'RS256', der: true }), 'bad signature');
  });

  it('refuses alg none', async () => {
    await refusal(iss.sign(iss.claims(), { none: true }), 'unsupported algorithm');
  });

  it('refuses an HMAC token signed with the public key as the secret', async () => {
    await refusal(iss.sign(iss.claims(), { hmac: true }), 'unsupported algorithm');
  });

  it('refuses algorithms that are not on the list', async () => {
    for (const alg of ['HS256', 'RS384', 'PS256', 'ES384', 'EdDSA', 'rs256']) {
      await refusal(iss.sign(iss.claims(), { alg }), 'unsupported algorithm');
    }
  });

  it('refuses a header with crit', async () => {
    await refusal(iss.sign(iss.claims(), { header: { crit: ['exp'] } }), 'malformed');
  });

  it('refuses a token with no kid, and one with a kid that is not a string', async () => {
    await refusal(iss.sign(iss.claims(), { header: { kid: undefined } }), 'unknown key');
    await refusal(iss.sign(iss.claims(), { header: { kid: 5 } }), 'unknown key');
  });

  it('refuses things that are not tokens', async () => {
    for (const t of ['', 'abc', 'a.b', 'a.b.c.d', '..', 'a.b.c', `${'x'.repeat(MAX_TOKEN_BYTES)}.b.c`, undefined, null, 5]) {
      await refusal(t, 'malformed');
    }
  });

  it('refuses a payload that is not a JSON object', async () => {
    const enc = (v) => Buffer.from(v).toString('base64url');
    const h = enc(JSON.stringify({ alg: 'RS256', kid: 'rsa-1' }));
    await refusal(`${h}.${enc('[1]')}.${enc('x')}`, 'malformed');
    await refusal(`${h}.${enc('not json')}.${enc('x')}`, 'malformed');
  });

  it('refuses a token with an empty signature, and one with a signature that is the wrong length', async () => {
    const [h, p] = iss.sign(iss.claims()).split('.');
    await refusal(`${h}.${p}.`, 'bad signature');
    const [eh, ep] = iss.sign(iss.claims(), { kid: 'ec-1' }).split('.');
    await refusal(`${eh}.${ep}.${Buffer.alloc(70).toString('base64url')}`, 'bad signature');
  });

  it('refuses the wrong issuer, naming the user', async () => {
    await assert.rejects(verify(iss.sign(iss.claims({ iss: 'https://evil.example.test' }))), (e) => {
      assert.equal(e.reason, 'wrong issuer');
      assert.equal(e.user, 'Owner@Example.test');
      return true;
    });
  });

  it('refuses the wrong audience, a missing one, and an array without it', async () => {
    await refusal(iss.sign(iss.claims({ aud: 'https://other.example.test/mcp' })), 'wrong audience');
    await refusal(iss.sign(iss.claims({ aud: undefined })), 'wrong audience');
    await refusal(iss.sign(iss.claims({ aud: ['a', 'b'] })), 'wrong audience');
  });

  describe('time', () => {
    const now = Date.now();
    const sec = Math.floor(now / 1000);

    it('refuses an expired token, past the leeway', async () => {
      await refusal(iss.sign(iss.claims({ exp: sec - 120 })), 'expired', 401, { nowMs: now });
    });

    it('accepts a token that expired within the leeway', async () => {
      assert.ok(await verify(iss.sign(iss.claims({ exp: sec - 30 })), { nowMs: now }));
    });

    it('refuses a token with no exp, and one whose exp is not a number', async () => {
      await refusal(iss.sign(iss.claims({ exp: undefined })), 'malformed');
      await refusal(iss.sign(iss.claims({ exp: '9999999999' })), 'malformed');
    });

    it('refuses a token that is not valid yet, past the leeway', async () => {
      await refusal(iss.sign(iss.claims({ nbf: sec + 120 })), 'not yet valid', 401, { nowMs: now });
    });

    it('accepts a token that becomes valid within the leeway', async () => {
      assert.ok(await verify(iss.sign(iss.claims({ nbf: sec + 30 })), { nowMs: now }));
    });

    it('refuses an nbf that is not a number', async () => {
      await refusal(iss.sign(iss.claims({ nbf: 'soon' })), 'malformed');
    });
  });

  describe('the user', () => {
    it('refuses a user who is not listed with 403, naming them', async () => {
      await assert.rejects(verify(iss.sign(iss.claims({ email: 'someone@example.test' }))), (e) => {
        assert.equal(e.reason, 'user not allowed');
        assert.equal(e.status, 403);
        assert.equal(e.user, 'someone@example.test');
        return true;
      });
    });

    it('refuses a token with no user claim', async () => {
      await refusal(iss.sign(iss.claims({ email: undefined })), 'missing user claim');
      await refusal(iss.sign(iss.claims({ email: 5 })), 'missing user claim');
      await refusal(iss.sign(iss.claims({ email: '  ' })), 'missing user claim');
    });

    it('matches an email case-insensitively, for ASCII letters only', async () => {
      assert.ok(await verify(iss.sign(iss.claims({ email: 'OWNER@EXAMPLE.TEST' }))));
      // The Kelvin sign lower-cases to "k" under full Unicode folding: it must not match.
      const kelvin = parseAuthConfig({ issuer: iss.issuer, jwksUri: iss.jwksUri, audience: iss.audience, userClaim: 'email', users: ['kate@example.test'] }, 'https://mcp.example.test');
      await assert.rejects(verifyAccessToken(iss.sign(iss.claims({ email: '\u212Aate@example.test' })), kelvin, keys), (e) => e.reason === 'user not allowed');
    });

    it('refuses an email the issuer says is not verified, and accepts one that is or is not marked', async () => {
      await refusal(iss.sign(iss.claims({ email_verified: false })), 'email not verified', 403);
      await refusal(iss.sign(iss.claims({ email_verified: 'false' })), 'email not verified', 403);
      assert.ok(await verify(iss.sign(iss.claims({ email_verified: true }))));
      assert.ok(await verify(iss.sign(iss.claims())));
    });

    it('does not apply the verified-email rule to another claim', async () => {
      const bySub = parseAuthConfig({ issuer: iss.issuer, jwksUri: iss.jwksUri, audience: iss.audience, users: ['owner'] }, 'https://mcp.example.test');
      assert.ok(await verifyAccessToken(iss.sign(iss.claims({ email_verified: false })), bySub, keys));
    });
  });
});

describe('KeyStore', () => {
  let iss;
  // A fresh issuer for every test: several of them rotate or remove keys.
  beforeEach(async () => { iss = await createIssuer(); });
  afterEach(async () => { await iss.stop(); });

  const store = (extra = {}) => {
    const clock = { t: 1_000_000 };
    const s = new KeyStore({ jwksUri: iss.jwksUri, now: () => clock.t, ...extra });
    return { s, clock };
  };
  const cfg = () => parseAuthConfig({ issuer: iss.issuer, jwksUri: iss.jwksUri, audience: iss.audience, users: ['owner'] }, 'https://mcp.example.test');
  const verify = (s, token) => verifyAccessToken(token, cfg(), s);
  const reason = async (p) => { try { await p; return null; } catch (e) { return [e.reason, e.status]; } };

  it('fetches the keys once and reuses them', async () => {
    iss.setDown(false); iss.resetRequests();
    const { s } = store();
    await verify(s, iss.sign(iss.claims()));
    await verify(s, iss.sign(iss.claims()));
    await verify(s, iss.sign(iss.claims(), { kid: 'ec-1' }));
    assert.equal(iss.requests, 1);
  });

  it('shares one fetch between simultaneous requests', async () => {
    iss.resetRequests();
    const { s } = store();
    const t = iss.sign(iss.claims());
    await Promise.all([verify(s, t), verify(s, t), verify(s, t), verify(s, t)]);
    assert.equal(iss.requests, 1);
  });

  it('refetches for an unknown kid at most once a minute', async () => {
    iss.resetRequests();
    const { s, clock } = store();
    await verify(s, iss.sign(iss.claims()));
    assert.equal(iss.requests, 1);
    const unknown = () => iss.sign(iss.claims(), { header: { kid: 'nope' } });
    assert.deepEqual(await reason(verify(s, unknown())), ['unknown key', 401]);
    assert.equal(iss.requests, 1, 'a fetch inside the minute was made');
    clock.t += 30_000;
    assert.deepEqual(await reason(verify(s, unknown())), ['unknown key', 401]);
    assert.equal(iss.requests, 1);
    clock.t += 31_000;
    assert.deepEqual(await reason(verify(s, unknown())), ['unknown key', 401]);
    assert.equal(iss.requests, 2, 'a fetch after the minute was not made');
  });

  it('a made-up kid does not cost a fetch each time', async () => {
    iss.resetRequests();
    const { s } = store();
    await verify(s, iss.sign(iss.claims()));
    for (let i = 0; i < 20; i++) await reason(verify(s, iss.sign(iss.claims(), { header: { kid: `fake-${i}` } })));
    assert.equal(iss.requests, 1);
  });

  it('picks up a key the issuer has added, and stops accepting one it has removed', async () => {
    const { s, clock } = store();
    const old = iss.sign(iss.claims());
    await verify(s, old);
    const kid = iss.rotate('rsa-rotated');
    clock.t += 61_000;
    const fresh = iss.sign(iss.claims(), { kid });
    assert.ok(await verify(s, fresh), 'the new key should be picked up');
    clock.t += 61_000;
    // the old key is gone from the issuer, and is dropped once a refetch has replaced the set
    assert.deepEqual(await reason(verify(s, iss.sign(iss.claims(), { header: { kid: 'never' } }))), ['unknown key', 401]);
    assert.deepEqual(await reason(verify(s, old)), ['unknown key', 401]);
  });

  it('answers 503 when the keys cannot be fetched and none are held', async () => {
    iss.setDown(true);
    const { s } = store();
    assert.deepEqual(await reason(verify(s, iss.sign(iss.claims()))), ['keys unavailable', 503]);
    iss.setDown(false);
  });

  it('keeps accepting known keys when the issuer goes down, and answers 503 for an unknown one', async () => {
    iss.setDown(false);
    const { s, clock } = store();
    const t = iss.sign(iss.claims());
    await verify(s, t);
    iss.setDown(true);
    clock.t += 61_000;
    assert.ok(await verify(s, t), 'a held key should keep working');
    clock.t += 61_000;
    assert.deepEqual(await reason(verify(s, iss.sign(iss.claims(), { header: { kid: 'new-one' } }))), ['keys unavailable', 503]);
    iss.setDown(false);
  });

  it('recovers once the issuer is back, after the minimum gap', async () => {
    iss.setDown(true);
    const { s, clock } = store();
    const t = iss.sign(iss.claims());
    assert.deepEqual(await reason(verify(s, t)), ['keys unavailable', 503]);
    iss.setDown(false);
    clock.t += 61_000;
    assert.ok(await verify(s, t));
  });

  it('treats a key document that is not JSON, or has no keys, as unavailable', async () => {
    for (const body of ['not json', '{}', '{"keys": 5}']) {
      iss.setRaw(body);
      const { s } = store();
      assert.deepEqual(await reason(verify(s, iss.sign(iss.claims()))), ['keys unavailable', 503], body);
    }
    iss.setRaw(null);
  });

  it('refuses a key document over the size limit', async () => {
    iss.setRaw(JSON.stringify({ keys: [], pad: 'x'.repeat(70 * 1024) }));
    const { s } = store();
    assert.deepEqual(await reason(verify(s, iss.sign(iss.claims()))), ['keys unavailable', 503]);
    iss.setRaw(null);
  });

  it('ignores keys that are not usable: too small an RSA key, or a curve other than P-256', async () => {
    const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'jwk' });
    iss.setRaw(JSON.stringify({ keys: [{ ...small, kid: 'small' }, { ...p384, kid: 'p384' }] }));
    const { s } = store();
    await s.prefetch();
    assert.equal(s.size, 0);
    iss.setRaw(null);
  });

  it('ignores a key that is marked for encryption', async () => {
    const enc = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
    iss.setRaw(JSON.stringify({ keys: [{ ...enc, kid: 'enc', use: 'enc' }] }));
    const { s } = store();
    await s.prefetch();
    assert.equal(s.size, 0);
    iss.setRaw(null);
  });

  it('does not hammer an issuer that is down once the keys are old', async () => {
    const { s, clock } = store();
    const t = iss.sign(iss.claims());
    await verify(s, t);
    iss.setDown(true);
    iss.resetRequests();
    clock.t += 2 * 3_600_000; // older than the hour after which a refresh is due
    for (let i = 0; i < 20; i++) {
      assert.ok(await verify(s, t), 'the held key should keep working');
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(iss.requests, 1, 'one attempt, not one per request');
    clock.t += 61_000;
    await verify(s, t);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(iss.requests, 2, 'another attempt after the gap');
  });

  it('keeps the keys it holds when the issuer serves a document with none usable', async () => {
    const { s, clock } = store();
    const t = iss.sign(iss.claims());
    await verify(s, t);
    iss.setRaw(JSON.stringify({ keys: [] }));
    clock.t += 61_000;
    assert.deepEqual(await reason(verify(s, iss.sign(iss.claims(), { header: { kid: 'x' } }))), ['keys unavailable', 503]);
    assert.ok(await verify(s, t), 'the held key should still work');
  });

  it('prefetch reports whether the endpoint could be read', async () => {
    iss.setDown(true);
    const a = store().s;
    assert.equal(await a.prefetch(), false);
    assert.ok(a.lastError);
    iss.setDown(false);
    assert.equal(await store().s.prefetch(), true);
  });
});
