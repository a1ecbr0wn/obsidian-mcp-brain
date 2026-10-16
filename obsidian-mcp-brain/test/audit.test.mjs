import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditValue, formatAudit, redactUrl, requestHost, toolTarget, TARGET_ARGS } from '../lib/audit.mjs';
import { openLogFile } from '../lib/logfile.mjs';
import { compileTrustedProxies } from '../lib/uploads.mjs';

// ── auditValue and formatAudit ──────────────────────────────────────────────

describe('auditValue', () => {
  it('keeps plain text', () => {
    assert.equal(auditValue('inbox/note.md'), 'inbox/note.md');
    assert.equal(auditValue(42), '42');
    assert.equal(auditValue(true), 'true');
  });

  it('turns spaces and other whitespace into underscores, so a value is one word', () => {
    assert.equal(auditValue('a b\tc'), 'a_b_c');
  });

  it('cannot carry a line break or a control character', () => {
    const v = auditValue('x\r\nAUDIT event=forged\u0000\u001b[31m');
    assert.ok([...v].every(c => c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e), v);
  });

  it('replaces non-ASCII text', () => {
    assert.equal(auditValue('café'), 'caf?');
  });

  it('cuts a long value to 100 characters', () => {
    assert.equal(auditValue('x'.repeat(500)).length, 100);
  });

  it('writes nothing and nothing-like values as a dash', () => {
    for (const v of ['', undefined, null]) assert.equal(auditValue(v), '-');
  });
});

describe('formatAudit', () => {
  it('writes the event and the fields in order', () => {
    assert.equal(formatAudit('tool', { tool: 'read-note', user: 'a@example.test' }),
      'AUDIT event=tool tool=read-note user=a@example.test');
  });

  it('leaves out a field whose value is undefined, and keeps a null as a dash', () => {
    assert.equal(formatAudit('login', { user: undefined, addr: null }), 'AUDIT event=login addr=-');
  });

  it('cannot be made to add a field or a line by a value', () => {
    const line = formatAudit('tool', { filename: 'a.md event=forged\nAUDIT event=login' });
    assert.equal(line.split('\n').length, 1);
    assert.equal(line.match(/ event=/g).length, 1, line);
  });

  it('writes an event with no fields', () => {
    assert.equal(formatAudit('stop'), 'AUDIT event=stop');
  });
});

// ── toolTarget ──────────────────────────────────────────────────────────────

describe('toolTarget', () => {
  it('keeps the allowlisted arguments', () => {
    assert.deepEqual(toolTarget({ vault: 'v', folder: 'inbox', filename: 'a.md' }),
      { vault: 'v', folder: 'inbox', filename: 'a.md' });
  });

  it('never keeps note text, a query or anything else that is not on the list', () => {
    const t = toolTarget({
      vault: 'v', content: 'secret text', query: 'secret query', question: 'q', taskText: 't',
      location: 'x', expectedMtime: 'x', sha256: 'x', token: 'x',
    });
    assert.deepEqual(t, { vault: 'v' });
  });

  it('joins an array of strings, and drops other shapes', () => {
    assert.deepEqual(toolTarget({ tags: ['a', 'b'] }), { tags: 'a,b' });
    assert.deepEqual(toolTarget({ tags: [1, 2], path: { x: 1 }, folder: null }), {});
  });

  it('keeps numbers and booleans', () => {
    assert.deepEqual(toolTarget({ size: 70, permanent: true }), { size: 70, permanent: true });
  });

  it('reduces a url to scheme, host and path', () => {
    assert.deepEqual(toolTarget({ url: 'https://example.com/a.pdf?token=s3cret#frag' }),
      { url: 'https://example.com/a.pdf' });
    assert.equal(redactUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(redactUrl('https://example.com:8443/a/b.pdf'), 'https://example.com:8443/a/b.pdf');
  });

  it('removes credentials in front of the host', () => {
    assert.equal(redactUrl('https://user:s3cret@example.com/a.pdf?x=1'), 'https://example.com/a.pdf');
    assert.equal(redactUrl('http://s3cret@example.com'), 'http://example.com/');
    assert.equal(redactUrl('https://u:p%40ss@example.com/a'), 'https://example.com/a');
    assert.equal(redactUrl('https://example.com/a@b'), 'https://example.com/a@b');
    assert.equal(redactUrl('https://example.com?next=https://u:p@x.test/'), 'https://example.com/');
  });

  it('writes a dash for a value it cannot parse, so no part of a password is left', () => {
    for (const bad of ['https://user:pa#ss@host/x', 'https://user:pa?ss@host/x', 'not a url', '', '//u:p@host/x']) {
      const logged = redactUrl(bad);
      assert.ok(!/pa|ss|u:p/.test(logged), `${bad} -> ${logged}`);
    }
    assert.equal(redactUrl('not a url'), '-');
  });

  it('copes with arguments that are missing or not an object', () => {
    for (const a of [undefined, null, 'x', 5, ['vault']]) assert.deepEqual(toolTarget(a), {});
  });

  it('has no argument on the list that holds note text', () => {
    for (const bad of ['content', 'query', 'question', 'taskText', 'files', 'outline']) {
      assert.ok(!TARGET_ARGS.includes(bad), bad);
    }
  });
});

// ── requestHost ─────────────────────────────────────────────────────────────

describe('requestHost', () => {
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
  const trusted = compileTrustedProxies(['127.0.0.1']);

  it('is the Host header', () => {
    assert.equal(requestHost(req('203.0.113.9', { host: 'example.com' }), trusted), 'example.com');
    assert.equal(requestHost(req('203.0.113.9', { host: 'example.com' }), null), 'example.com');
  });

  it('ignores X-Forwarded-Host from a connection that is not a trusted proxy', () => {
    assert.equal(requestHost(req('203.0.113.9', { host: 'example.com', 'x-forwarded-host': 'evil.test' }), trusted), 'example.com');
  });

  it('uses the last X-Forwarded-Host entry from a trusted proxy', () => {
    assert.equal(requestHost(req('127.0.0.1', { host: 'internal', 'x-forwarded-host': 'forged.test, brain.example.com' }), trusted), 'brain.example.com');
    assert.equal(requestHost(req('::ffff:127.0.0.1', { host: 'internal', 'x-forwarded-host': 'brain.example.com' }), trusted), 'brain.example.com');
  });

  it('falls back to Host when a trusted proxy sends no usable X-Forwarded-Host', () => {
    assert.equal(requestHost(req('127.0.0.1', { host: 'internal', 'x-forwarded-host': '  ' }), trusted), 'internal');
  });

  it('is empty when the request names no host', () => {
    assert.equal(requestHost(req('203.0.113.9', {}), trusted), '');
  });
});

// ── openLogFile ─────────────────────────────────────────────────────────────

describe('openLogFile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logfile-test-'));
  const file = name => path.join(dir, name);

  it('creates the file readable by its owner only, and appends lines in order', async () => {
    const f = openLogFile(file('a.log'));
    f.write('one');
    f.write('two');
    f.close();
    assert.equal(await fs.readFile(file('a.log'), 'utf8'), 'one\ntwo\n');
    assert.equal((await fs.stat(file('a.log'))).mode & 0o777, 0o600);
    assert.equal(f.tightened, false);
  });

  it('appends to an existing file and makes it owner-only', async () => {
    await fs.writeFile(file('b.log'), 'old\n', { mode: 0o644 });
    await fs.chmod(file('b.log'), 0o644);
    const f = openLogFile(file('b.log'));
    f.write('new');
    f.close();
    assert.equal(await fs.readFile(file('b.log'), 'utf8'), 'old\nnew\n');
    assert.equal((await fs.stat(file('b.log'))).mode & 0o777, 0o600);
    assert.equal(f.tightened, true);
  });

  it('writes to a new file after reopen, once the old one has been moved', async () => {
    const f = openLogFile(file('c.log'));
    f.write('before');
    await fs.rename(file('c.log'), file('c.log.1'));
    f.write('still the moved file');
    f.reopen();
    f.write('after');
    f.close();
    assert.equal(await fs.readFile(file('c.log.1'), 'utf8'), 'before\nstill the moved file\n');
    assert.equal(await fs.readFile(file('c.log'), 'utf8'), 'after\n');
  });

  it('keeps writing to the old file when reopen fails', async () => {
    const sub = path.join(dir, 'gone');
    await fs.mkdir(sub);
    const f = openLogFile(path.join(sub, 'd.log'));
    f.write('one');
    await fs.rename(path.join(sub, 'd.log'), file('d.log.moved'));
    await fs.rmdir(sub);
    assert.throws(() => f.reopen());
    f.write('two');
    f.close();
    assert.equal(await fs.readFile(file('d.log.moved'), 'utf8'), 'one\ntwo\n');
  });

  it('throws when the folder does not exist', () => {
    assert.throws(() => openLogFile(path.join(dir, 'missing', 'x.log')), /ENOENT/);
  });

  it('does nothing when written to after close', () => {
    const f = openLogFile(file('e.log'));
    f.close();
    f.write('ignored');
    assert.equal(fsSync.readFileSync(file('e.log'), 'utf8'), '');
  });
});
