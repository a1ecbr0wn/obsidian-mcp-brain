import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UploadSlots,
  normalizeAddress,
  compileTrustedProxies,
  callerAddress,
  checkStagingDir,
  checkStagingDirOwner,
  defaultUploadTempDir,
  resolveDestination,
  sweepStaging,
} from '../lib/uploads.mjs';

const SHA = 'a'.repeat(64);
const slotInfo = (over = {}) => ({ vault: 'v', relPath: 'a/b.pdf', size: 10, sha256: SHA, address: '203.0.113.5', ...over });

// ── UploadSlots ─────────────────────────────────────────────────────────────

describe('UploadSlots', () => {
  const makeStore = (over = {}) => {
    const clock = { t: 1_000_000 };
    const store = new UploadSlots({ ttlMs: 5000, maxOutstanding: 3, now: () => clock.t, ...over });
    return { store, clock };
  };

  it('creates a slot with a 256-bit base64url token and an expiry', () => {
    const { store } = makeStore();
    const { token, expiresAt } = store.create(slotInfo());
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(expiresAt, 1_000_000 + 5000);
  });

  it('issues a different token every time', () => {
    const { store } = makeStore({ maxOutstanding: 50 });
    const tokens = new Set();
    for (let i = 0; i < 30; i++) tokens.add(store.create(slotInfo()).token);
    assert.equal(tokens.size, 30);
  });

  it('stores only a hash of the token, never the token itself', () => {
    const { store } = makeStore();
    const { token } = store.create(slotInfo());
    const keys = store._keys();
    assert.equal(keys.length, 1);
    assert.notEqual(keys[0], token);
    assert.equal(keys[0], crypto.createHash('sha256').update(token).digest('hex'));
  });

  it('consume returns the slot details once, then nothing', () => {
    const { store } = makeStore();
    const { token } = store.create(slotInfo({ relPath: 'x/y.png', size: 42, address: '198.51.100.1' }));
    const slot = store.consume(token);
    assert.equal(slot.vault, 'v');
    assert.equal(slot.relPath, 'x/y.png');
    assert.equal(slot.size, 42);
    assert.equal(slot.sha256, SHA);
    assert.equal(slot.address, '198.51.100.1');
    assert.equal(store.consume(token), null);
  });

  it('normalises the declared hash to lower case', () => {
    const { store } = makeStore();
    const { token } = store.create(slotInfo({ sha256: 'ABCDEF' + 'a'.repeat(58) }));
    assert.equal(store.consume(token).sha256, 'abcdef' + 'a'.repeat(58));
  });

  it('returns null for an unknown or malformed token', () => {
    const { store } = makeStore();
    store.create(slotInfo());
    assert.equal(store.consume('x'.repeat(43)), null);
    assert.equal(store.consume(''), null);
    assert.equal(store.consume(undefined), null);
    assert.equal(store.consume('../../etc/passwd'), null);
  });

  it('expires a slot once its lifetime has passed, and removes it', () => {
    const { store, clock } = makeStore();
    const { token } = store.create(slotInfo());
    clock.t += 5000; // exactly the lifetime: expired
    assert.equal(store.consume(token), null);
    assert.equal(store.size, 0);
  });

  it('a slot is still valid just before it expires', () => {
    const { store, clock } = makeStore();
    const { token } = store.create(slotInfo());
    clock.t += 4999;
    assert.ok(store.consume(token));
  });

  it('refuses to create a slot for an empty address, which would match any other empty address', () => {
    const { store } = makeStore();
    assert.throws(() => store.create(slotInfo({ address: '' })), err => err.code === 'NO_ADDRESS');
    assert.throws(() => store.create(slotInfo({ address: undefined })), err => err.code === 'NO_ADDRESS');
    assert.equal(store.size, 0);
  });

  it('refuses to create more than maxOutstanding slots', () => {
    const { store } = makeStore();
    for (let i = 0; i < 3; i++) store.create(slotInfo());
    assert.throws(() => store.create(slotInfo()), err => err.code === 'TOO_MANY_SLOTS');
  });

  it('consumed and expired slots free capacity', () => {
    const { store, clock } = makeStore();
    const a = store.create(slotInfo());
    store.create(slotInfo());
    store.create(slotInfo());
    store.consume(a.token);
    store.create(slotInfo()); // freed by consume
    clock.t += 5000;
    store.create(slotInfo()); // freed by expiry (create sweeps first)
    assert.equal(store.size, 1);
  });

  it('sweep removes only expired slots and reports how many', () => {
    const { store, clock } = makeStore();
    store.create(slotInfo());
    clock.t += 3000;
    const live = store.create(slotInfo());
    clock.t += 2500; // first expired, second not
    assert.equal(store.sweep(), 1);
    assert.equal(store.size, 1);
    assert.ok(store.consume(live.token));
  });
});

// ── normalizeAddress ────────────────────────────────────────────────────────

describe('normalizeAddress', () => {
  it('unwraps an IPv4-mapped IPv6 address in dotted form', () => {
    assert.equal(normalizeAddress('::ffff:203.0.113.5'), '203.0.113.5');
  });

  it('unwraps an IPv4-mapped IPv6 address in hex form', () => {
    assert.equal(normalizeAddress('::ffff:7f00:1'), '127.0.0.1');
    assert.equal(normalizeAddress('::FFFF:CB00:7105'), '203.0.113.5');
  });

  it('leaves plain IPv4 and IPv6 addresses alone, lower-casing IPv6', () => {
    assert.equal(normalizeAddress('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeAddress('::1'), '::1');
    assert.equal(normalizeAddress('2001:DB8::A'), '2001:db8::a');
  });

  it('strips an IPv6 zone identifier', () => {
    assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1');
  });

  it('gives every spelling of an IPv6 address the same canonical form', () => {
    assert.equal(normalizeAddress('2001:db8:0:0::1'), '2001:db8::1');
    assert.equal(normalizeAddress('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
    assert.equal(normalizeAddress('::1'), '::1');
  });

  it('returns an empty string for a missing value', () => {
    assert.equal(normalizeAddress(undefined), '');
    assert.equal(normalizeAddress(null), '');
  });
});

// ── compileTrustedProxies ───────────────────────────────────────────────────

describe('compileTrustedProxies', () => {
  it('an empty list trusts nothing', () => {
    const tp = compileTrustedProxies([]);
    assert.equal(tp.check('127.0.0.1'), false);
    assert.equal(tp.isEmpty, true);
  });

  it('accepts single addresses of both families', () => {
    const tp = compileTrustedProxies(['127.0.0.1', '::1']);
    assert.equal(tp.check('127.0.0.1'), true);
    assert.equal(tp.check('::1'), true);
    assert.equal(tp.check('127.0.0.2'), false);
    assert.equal(tp.isEmpty, false);
  });

  it('accepts CIDR ranges of both families', () => {
    const tp = compileTrustedProxies(['10.0.0.0/8', '2001:db8::/32']);
    assert.equal(tp.check('10.255.0.1'), true);
    assert.equal(tp.check('11.0.0.1'), false);
    assert.equal(tp.check('2001:db8::5'), true);
    assert.equal(tp.check('2001:db9::5'), false);
  });

  it('matches an IPv4-mapped IPv6 input against an IPv4 entry', () => {
    const tp = compileTrustedProxies(['127.0.0.1']);
    assert.equal(tp.check('::ffff:127.0.0.1'), true);
  });

  it('accepts an IPv4-mapped IPv6 entry as the IPv4 address it wraps', () => {
    const tp = compileTrustedProxies(['::ffff:10.0.0.1']);
    assert.equal(tp.check('10.0.0.1'), true);
  });

  it('never trusts an empty or malformed candidate', () => {
    const tp = compileTrustedProxies(['10.0.0.0/8']);
    assert.equal(tp.check(''), false);
    assert.equal(tp.check('not-an-ip'), false);
  });

  for (const bad of ['nonsense', '', '10.0.0.0/33', '10.0.0.0/abc', '1.2.3.4/', '2001:db8::/129', '10.0.0.0/-1', '1.2.3']) {
    it(`rejects ${JSON.stringify(bad)} with an error naming it`, () => {
      assert.throws(() => compileTrustedProxies([bad]), err => err.message.includes(JSON.stringify(bad)));
    });
  }
});

// ── callerAddress ───────────────────────────────────────────────────────────

describe('callerAddress', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  const trust = (...list) => compileTrustedProxies(list);

  it('is the peer address when no proxies are trusted, even if the header is present', () => {
    assert.equal(callerAddress(req('192.0.2.1', '203.0.113.5'), trust()), '192.0.2.1');
  });

  it('normalises an IPv4-mapped peer address', () => {
    assert.equal(callerAddress(req('::ffff:192.0.2.1'), trust()), '192.0.2.1');
  });

  it('reads X-Forwarded-For when the connection comes from a trusted proxy', () => {
    assert.equal(callerAddress(req('127.0.0.1', '203.0.113.5'), trust('127.0.0.1')), '203.0.113.5');
  });

  it('is the peer address when a trusted proxy sends no header', () => {
    assert.equal(callerAddress(req('127.0.0.1'), trust('127.0.0.1')), '127.0.0.1');
  });

  it('ignores a forged header from a connection that is not a trusted proxy', () => {
    assert.equal(callerAddress(req('192.0.2.1', '203.0.113.5'), trust('127.0.0.1')), '192.0.2.1');
  });

  it('skips trusted proxies in the chain, taking entries from the right', () => {
    assert.equal(
      callerAddress(req('127.0.0.1', '198.51.100.9, 10.0.0.2'), trust('127.0.0.1', '10.0.0.0/8')),
      '198.51.100.9',
    );
  });

  it('ignores a forged leftmost entry: the rightmost untrusted entry wins', () => {
    assert.equal(callerAddress(req('127.0.0.1', '1.1.1.1, 203.0.113.5'), trust('127.0.0.1')), '203.0.113.5');
  });

  it('is the leftmost entry when every entry is a trusted proxy', () => {
    assert.equal(callerAddress(req('127.0.0.1', '10.0.0.5, 10.0.0.2'), trust('127.0.0.1', '10.0.0.0/8')), '10.0.0.5');
  });

  it('gives an empty address, which matches nothing, if a trusted proxy sends a malformed header', () => {
    assert.equal(callerAddress(req('127.0.0.1', 'garbage'), trust('127.0.0.1')), '');
    assert.equal(callerAddress(req('127.0.0.1', '203.0.113.5, '), trust('127.0.0.1')), '');
    assert.equal(callerAddress(req('127.0.0.1', '203.0.113.5:4711'), trust('127.0.0.1')), '');
    assert.equal(callerAddress(req('127.0.0.1', '[2001:db8::1]'), trust('127.0.0.1')), '');
    assert.equal(callerAddress(req('127.0.0.1', 'evil, 203.0.113.5'), trust('127.0.0.1')), '');
  });

  it('treats an empty header from a trusted proxy as no header', () => {
    assert.equal(callerAddress(req('127.0.0.1', ''), trust('127.0.0.1')), '127.0.0.1');
  });

  it('gives an empty address when the connection has no peer address', () => {
    assert.equal(callerAddress({ socket: {}, headers: {} }, trust()), '');
    assert.equal(callerAddress({ headers: {} }, null), '');
  });

  it('compares IPv6 callers by their canonical form', () => {
    const a = callerAddress(req('127.0.0.1', '2001:db8:0:0::1'), trust('127.0.0.1'));
    const b = callerAddress(req('127.0.0.1', '2001:0db8::0001'), trust('127.0.0.1'));
    assert.equal(a, b);
  });

  it('normalises an IPv4-mapped entry in the header', () => {
    assert.equal(callerAddress(req('127.0.0.1', '::ffff:203.0.113.5'), trust('127.0.0.1')), '203.0.113.5');
  });

  it('matches a mapped-IPv6 peer against an IPv4 trusted proxy', () => {
    assert.equal(callerAddress(req('::ffff:127.0.0.1', '203.0.113.5'), trust('127.0.0.1')), '203.0.113.5');
  });
});

// ── checkStagingDir ─────────────────────────────────────────────────────────

describe('checkStagingDir', () => {
  const vaults = ['/data/vault', '/srv/notes'];

  it('accepts an absolute folder outside every vault', () => {
    assert.equal(checkStagingDir('/var/tmp/uploads', vaults), null);
  });

  it('rejects a relative path', () => {
    assert.match(checkStagingDir('tmp/uploads', vaults), /absolute/);
  });

  it('rejects a folder that is a vault or inside one', () => {
    assert.match(checkStagingDir('/data/vault', vaults), /vault/);
    assert.match(checkStagingDir('/data/vault/.uploads', vaults), /vault/);
    assert.match(checkStagingDir('/srv/notes/sub/dir/', vaults), /vault/);
  });

  it('rejects a folder that contains a vault', () => {
    assert.match(checkStagingDir('/data', vaults), /vault/);
    assert.match(checkStagingDir('/', vaults), /vault/);
  });

  it('does not confuse a sibling that shares a name prefix with a vault', () => {
    assert.equal(checkStagingDir('/data/vault2/uploads', vaults), null);
    assert.equal(checkStagingDir('/data/vault-staging', vaults), null);
  });
});

// ── defaults and staging sweep ──────────────────────────────────────────────

describe('defaultUploadTempDir', () => {
  it('is an obsidian-mcp-uploads folder named for the user, under the temporary directory', () => {
    const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
    assert.equal(defaultUploadTempDir(), path.join(os.tmpdir(), `obsidian-mcp-uploads${uid}`));
  });
});

describe('checkStagingDirOwner', () => {
  const dir = (uid) => ({ isDirectory: () => true, uid });

  it('accepts a directory owned by this user', () => {
    assert.equal(checkStagingDirOwner(dir(1000), 1000), null);
  });

  it('rejects a directory owned by someone else', () => {
    assert.match(checkStagingDirOwner(dir(0), 1000), /another user/);
  });

  it('rejects something that is not a directory', () => {
    assert.match(checkStagingDirOwner({ isDirectory: () => false, uid: 1000 }, 1000), /not a directory/);
  });

  it('does not check ownership where there is no user id', () => {
    assert.equal(checkStagingDirOwner(dir(5), undefined), null);
  });
});

describe('resolveDestination', () => {
  const withVault = async (fn) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-test-'));
    const vault = path.join(root, 'vault');
    const outside = path.join(root, 'outside');
    await fs.mkdir(vault);
    await fs.mkdir(outside);
    try { await fn({ root, vault, outside }); } finally { await fs.rm(root, { recursive: true, force: true }); }
  };

  it('accepts a destination in folders that do not exist yet', async () => {
    await withVault(async ({ vault }) => {
      assert.deepEqual(await resolveDestination(vault, 'a/b/c.bin'), { ok: true, rel: 'a/b/c.bin' });
    });
  });

  it('accepts a destination in an existing folder', async () => {
    await withVault(async ({ vault }) => {
      await fs.mkdir(path.join(vault, 'docs'));
      assert.deepEqual(await resolveDestination(vault, 'docs/c.bin'), { ok: true, rel: 'docs/c.bin' });
    });
  });

  it('rejects a folder that is a symbolic link out of the vault', async () => {
    await withVault(async ({ vault, outside }) => {
      await fs.symlink(outside, path.join(vault, 'link'));
      assert.deepEqual(await resolveDestination(vault, 'link/esc.bin'), { ok: false });
      assert.deepEqual(await resolveDestination(vault, 'link/not/yet/there/esc.bin'), { ok: false });
    });
  });

  it('rejects a destination that is itself a symbolic link out of the vault', async () => {
    await withVault(async ({ vault, outside }) => {
      await fs.writeFile(path.join(outside, 'target.bin'), 'x');
      await fs.symlink(path.join(outside, 'target.bin'), path.join(vault, 'alias.bin'));
      assert.deepEqual(await resolveDestination(vault, 'alias.bin'), { ok: false });
    });
  });

  it('follows a symbolic link that stays inside the vault, reporting the real location', async () => {
    await withVault(async ({ vault }) => {
      await fs.mkdir(path.join(vault, 'real'));
      await fs.symlink(path.join(vault, 'real'), path.join(vault, 'alias'));
      assert.deepEqual(await resolveDestination(vault, 'alias/c.bin'), { ok: true, rel: 'real/c.bin' });
    });
  });

  it('works when the vault path itself is reached through a symbolic link', async () => {
    await withVault(async ({ root, vault }) => {
      await fs.symlink(vault, path.join(root, 'vault-link'));
      assert.deepEqual(await resolveDestination(path.join(root, 'vault-link'), 'a/c.bin'), { ok: true, rel: 'a/c.bin' });
    });
  });
});

describe('sweepStaging', () => {
  it('removes only stale upload-*.part files and reports how many', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-test-'));
    try {
      await fs.writeFile(path.join(dir, 'upload-aa11.part'), 'x');
      await fs.writeFile(path.join(dir, 'upload-bb22.part'), 'x');
      await fs.writeFile(path.join(dir, 'other.txt'), 'keep');
      await fs.writeFile(path.join(dir, 'upload-cc33.txt'), 'keep');
      await fs.mkdir(path.join(dir, 'upload-dir.part'));
      assert.equal(await sweepStaging(dir), 2);
      assert.deepEqual((await fs.readdir(dir)).sort(), ['other.txt', 'upload-cc33.txt', 'upload-dir.part']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 for a folder that does not exist', async () => {
    assert.equal(await sweepStaging(path.join(os.tmpdir(), 'no-such-sweep-dir-xyz')), 0);
  });
});
