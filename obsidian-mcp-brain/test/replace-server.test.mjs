/**
 * Integration tests for replace-file and PUT /up/<token> in replace mode, and for the
 * sha256 and Last-Modified lines of read-file that feed it.
 * Spawns a real server with its own vault and staging folder (ports 20500 and up).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');

let nextPort = 20500;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startServer(extra = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-test-'));
  const vaultDir = path.join(root, 'vault');
  const uploadDir = path.join(root, 'staging');
  await fs.mkdir(vaultDir);
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port,
    mcpBaseUrl: `http://127.0.0.1:${port}`,
    denyPaths: ['private'],
    denyBinaryPaths: ['protected'],
    uploadMaxBytes: 65536,
    uploadTempDir: uploadDir,
    vaults: { v: { path: vaultDir } },
    ...extra,
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const onData = chunk => { log += chunk.toString(); if (log.includes('listening')) resolve(); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', code => reject(new Error(`server exited early with code ${code}\n${log}`)));
    setTimeout(() => reject(new Error(`server startup timeout\n${log}`)), 15_000);
  });
  proc.stdout.on('data', c => { log += c.toString(); });
  proc.stderr.on('data', c => { log += c.toString(); });
  return {
    port, vaultDir, uploadDir, log: () => log,
    async stop() {
      if (proc.exitCode === null) await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function mcpPost(port, body, sid) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    if (sid) headers['mcp-session-id'] = sid;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, agent: false }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const msgs = [];
        for (const line of data.split('\n')) if (line.startsWith('data: ')) { try { msgs.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ } }
        resolve({ headers: res.headers, msgs });
      });
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

async function callTool(srv, name, args) {
  const init = await mcpPost(srv.port, {
    jsonrpc: '2.0', id: '1', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  const sid = init.headers['mcp-session-id'];
  const r = await mcpPost(srv.port, { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name, arguments: { vault: 'v', ...args } } }, sid);
  return r.msgs[0].result;
}

function put(urlStr, body, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(urlStr);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT', headers: { 'Content-Length': body.length, ...headers }, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', err => resolve({ error: err }));
    req.end(body);
  });
}

/** The version of a vault file that a caller read: what replace-file takes. */
async function versionOf(file) {
  const stat = await fs.stat(file);
  return { expectedSha256: sha256(await fs.readFile(file)), expectedMtime: stat.mtime.toISOString() };
}

/** Reserves a replacement; returns the tool result, its text and the URL. */
async function reserveReplace(srv, { filename, folder, content, size, sha, expect }) {
  const result = await callTool(srv, 'replace-file', {
    filename, ...(folder ? { folder } : {}),
    size: size ?? content.length, sha256: sha ?? sha256(content),
    ...expect,
  });
  const text = result.content?.[0]?.text ?? '';
  const url = text.match(/https?:\/\/\S+\/up\/[A-Za-z0-9_-]{43}/)?.[0];
  return { result, text, url };
}

const stagingFiles = async (srv) => (await fs.readdir(srv.uploadDir)).filter(f => f.startsWith('upload-'));
const trashFiles = async (srv) => fs.readdir(path.join(srv.vaultDir, '.trash')).catch(() => []);

describe('replace-file', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  /** Puts a file in the vault with a fixed mtime in the past, and returns its path and version. */
  async function seed(rel, content) {
    const file = path.join(srv.vaultDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(file, past, past);
    return { file, expect: await versionOf(file) };
  }

  describe('the tool', () => {
    it('is listed with every version check required', async () => {
      const init = await mcpPost(srv.port, { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      const list = await mcpPost(srv.port, { jsonrpc: '2.0', id: '2', method: 'tools/list' }, init.headers['mcp-session-id']);
      const tool = list.msgs[0].result.tools.find(t => t.name === 'replace-file');
      assert.ok(tool);
      assert.deepEqual([...tool.inputSchema.required].sort(), ['expectedMtime', 'expectedSha256', 'filename', 'sha256', 'size', 'vault']);
    });

    it('reserves a one-time URL for a file whose version matches', async () => {
      const { expect } = await seed('r-ok/a.bin', crypto.randomBytes(200));
      const content = crypto.randomBytes(300);
      const { result, text, url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'r-ok', content, expect });
      assert.ok(!result.isError, text);
      assert.ok(url, text);
      assert.ok(text.startsWith('Replacement reserved: r-ok/a.bin'), text);
      assert.ok(text.includes(expect.expectedSha256), text);
      assert.ok(text.includes('.trash'), text);
    });

    it('refuses a file that is not in the vault, and says to use upload-file', async () => {
      const content = crypto.randomBytes(10);
      const { result, text } = await reserveReplace(srv, { filename: 'nothing.bin', content, expect: { expectedSha256: sha256(Buffer.from('x')), expectedMtime: '2026-01-01T00:00:00.000Z' } });
      assert.equal(result.isError, true);
      assert.ok(text.includes('File does not exist') && text.includes('upload-file'), text);
    });

    it('refuses a hash that is not the current file, without saying what the file is', async () => {
      const { expect } = await seed('r-hash/a.bin', crypto.randomBytes(100));
      const wrong = sha256(Buffer.from('another version'));
      const content = crypto.randomBytes(50);
      const { result, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'r-hash', content, expect: { ...expect, expectedSha256: wrong } });
      assert.equal(result.isError, true);
      assert.ok(text.includes('changed since it was read') && text.includes('read-file'), text);
      assert.ok(!text.includes(expect.expectedSha256), 'the current hash must not be given away');
    });

    it('refuses an mtime that is not the current one', async () => {
      const { expect } = await seed('r-mtime/a.bin', crypto.randomBytes(100));
      const { result, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'r-mtime', content: crypto.randomBytes(50), expect: { ...expect, expectedMtime: '2020-01-01T00:00:00.000Z' } });
      assert.equal(result.isError, true);
      assert.ok(text.includes('Precondition failed'), text);
    });

    it('refuses missing or malformed expected values', async () => {
      const { expect } = await seed('r-bad/a.bin', crypto.randomBytes(100));
      const content = crypto.randomBytes(50);
      for (const bad of [
        { ...expect, expectedSha256: 'abc' },
        { ...expect, expectedSha256: undefined },
        { ...expect, expectedMtime: 'yesterday' },
        { ...expect, expectedMtime: undefined },
      ]) {
        const { result, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'r-bad', content, expect: bad });
        assert.equal(result.isError, true, JSON.stringify(bad));
        assert.ok(/expectedSha256|expectedMtime/.test(text), text);
      }
    });

    it('refuses a new file that is identical to the current one', async () => {
      const bytes = crypto.randomBytes(100);
      const { expect } = await seed('r-same/a.bin', bytes);
      const { result, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'r-same', content: bytes, expect });
      assert.equal(result.isError, true);
      assert.ok(text.includes('nothing to replace'), text);
    });

    it('refuses a denied path, a protected binary file and a directory', async () => {
      const content = crypto.randomBytes(20);
      const priv = await seed('private/a.bin', crypto.randomBytes(30));
      const prot = await seed('protected/a.bin', crypto.randomBytes(30));
      await fs.mkdir(path.join(srv.vaultDir, 'dir.bin'));
      const dirExpect = { expectedSha256: sha256(Buffer.alloc(0)), expectedMtime: (await fs.stat(path.join(srv.vaultDir, 'dir.bin'))).mtime.toISOString() };
      const a = await reserveReplace(srv, { filename: 'a.bin', folder: 'private', content, expect: priv.expect });
      assert.match(a.text, /^Access denied/);
      const b = await reserveReplace(srv, { filename: 'a.bin', folder: 'protected', content, expect: prot.expect });
      assert.equal(b.result.isError, true);
      assert.ok(b.text.startsWith('Reading is restricted for'), b.text);
      const c = await reserveReplace(srv, { filename: 'dir.bin', content, expect: dirExpect });
      assert.equal(c.result.isError, true);
      assert.ok(c.text.includes('Not a regular file'), c.text);
    });

    it('upload-file points at replace-file when the file exists', async () => {
      await seed('r-hint/a.bin', crypto.randomBytes(10));
      const content = crypto.randomBytes(10);
      const result = await callTool(srv, 'upload-file', { filename: 'a.bin', folder: 'r-hint', size: 10, sha256: sha256(content) });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('replace-file'), result.content[0].text);
    });
  });

  describe('PUT /up/<token>', () => {
    it('swaps the file, moves the old version to .trash and answers 200 with the details', async () => {
      const oldBytes = crypto.randomBytes(400);
      const { file, expect } = await seed('p-ok/a.bin', oldBytes);
      const content = crypto.randomBytes(500);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'p-ok', content, expect });
      const r = await put(url, content);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(await fs.readFile(file), content);
      assert.equal(r.json.path, 'p-ok/a.bin');
      assert.equal(r.json.bytes, 500);
      assert.equal(r.json.sha256, sha256(content));
      assert.equal(r.json.replaced, true);
      assert.equal(r.json.previousSha256, expect.expectedSha256);
      assert.match(r.json.trashedAs, /^\.trash\/a_\d{13}\.bin$/);
      assert.deepEqual(await fs.readFile(path.join(srv.vaultDir, r.json.trashedAs)), oldBytes);
      assert.deepEqual(await stagingFiles(srv), []);
      assert.equal((await put(url, content)).status, 404, 'the URL is used up');
    });

    it('keeps the old file\'s permissions, and leaves no hidden temporary file behind', async () => {
      const { file, expect } = await seed('p-mode/a.bin', crypto.randomBytes(40));
      await fs.chmod(file, 0o640);
      const content = crypto.randomBytes(41);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'p-mode', content, expect });
      assert.equal((await put(url, content)).status, 200);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
      assert.deepEqual((await fs.readdir(path.dirname(file))).filter(f => f.startsWith('.')), []);
    });

    it('does not overwrite a file in .trash that has the same name', async () => {
      const first = await seed('p-trash/dup.bin', crypto.randomBytes(30));
      const c1 = crypto.randomBytes(31);
      const r1 = await put((await reserveReplace(srv, { filename: 'dup.bin', folder: 'p-trash', content: c1, expect: first.expect })).url, c1);
      assert.equal(r1.status, 200, r1.text);
      const c2 = crypto.randomBytes(32);
      const r2 = await put((await reserveReplace(srv, { filename: 'dup.bin', folder: 'p-trash', content: c2, expect: await versionOf(first.file) })).url, c2);
      assert.equal(r2.status, 200, r2.text);
      assert.notEqual(r1.json.trashedAs, r2.json.trashedAs);
      assert.equal((await trashFiles(srv)).filter(f => f.startsWith('dup')).length, 2);
    });

    it('refuses with 409 when the mtime changed after the reservation (the early check), and keeps the newer file', async () => {
      const { file, expect } = await seed('p-race/a.bin', crypto.randomBytes(60));
      const content = crypto.randomBytes(70);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'p-race', content, expect });
      const edited = crypto.randomBytes(61);
      await fs.writeFile(file, edited); // someone saves the file between the reservation and the upload
      const before = await trashFiles(srv);
      const r = await put(url, content);
      assert.equal(r.status, 409, r.text);
      assert.ok(r.json.error.includes('changed since it was read'), r.text);
      assert.deepEqual(await fs.readFile(file), edited, 'the newer version is untouched');
      assert.deepEqual(await trashFiles(srv), before, 'nothing was left in .trash');
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('refuses with 409 when only the content changed and the mtime was put back (the check on the trashed copy), leaving nothing in .trash', async () => {
      const { file, expect } = await seed('p-touch/a.bin', crypto.randomBytes(60));
      const content = crypto.randomBytes(70);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'p-touch', content, expect });
      await fs.writeFile(file, crypto.randomBytes(60));
      await fs.utimes(file, new Date(expect.expectedMtime), new Date(expect.expectedMtime));
      const before = await trashFiles(srv);
      const r = await put(url, content);
      assert.equal(r.status, 409, r.text);
      assert.deepEqual(await trashFiles(srv), before);
    });

    it('refuses with 409 when the file was deleted after the reservation', async () => {
      const { file, expect } = await seed('p-gone/a.bin', crypto.randomBytes(60));
      const content = crypto.randomBytes(70);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'p-gone', content, expect });
      await fs.unlink(file);
      const r = await put(url, content);
      assert.equal(r.status, 409, r.text);
      assert.ok(r.json.error.includes('no longer exists'), r.text);
      await assert.rejects(fs.access(file), 'nothing is created in its place');
    });

    it('refuses a body that does not match the declared hash, and leaves the file alone', async () => {
      const bytes = crypto.randomBytes(60);
      const { file, expect } = await seed('p-badhash/a.bin', bytes);
      const content = crypto.randomBytes(70);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'p-badhash', content, expect });
      const r = await put(url, crypto.randomBytes(70));
      assert.equal(r.status, 422, r.text);
      assert.deepEqual(await fs.readFile(file), bytes);
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('replaces through a symbolic link: the file it points at changes and the link stays', async () => {
      const real = await seed('p-link/real.bin', crypto.randomBytes(40));
      await fs.symlink('real.bin', path.join(srv.vaultDir, 'p-link/link.bin'));
      const content = crypto.randomBytes(41);
      const { url, text } = await reserveReplace(srv, { filename: 'link.bin', folder: 'p-link', content, expect: real.expect });
      assert.ok(url, text);
      assert.equal((await put(url, content)).status, 200);
      assert.deepEqual(await fs.readFile(real.file), content);
      assert.ok((await fs.lstat(path.join(srv.vaultDir, 'p-link/link.bin'))).isSymbolicLink());
    });

    it('refuses a link that points outside the vault', async () => {
      const outside = path.join(os.tmpdir(), `replace-outside-${process.pid}.bin`);
      await fs.writeFile(outside, 'outside');
      try {
        await fs.symlink(outside, path.join(srv.vaultDir, 'escape.bin'));
        const { result, text } = await reserveReplace(srv, { filename: 'escape.bin', content: crypto.randomBytes(10), expect: await versionOf(outside) });
        assert.equal(result.isError, true);
        assert.equal(text, 'Access denied');
        assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
      } finally {
        await fs.rm(outside, { force: true });
      }
    });

    it('replaces a note (.md) with valid UTF-8, and refuses one that is not UTF-8', async () => {
      const { file, expect } = await seed('p-note/n.md', '# old\n');
      const good = Buffer.from('# new ☕\n', 'utf8');
      const { url } = await reserveReplace(srv, { filename: 'n.md', folder: 'p-note', content: good, expect });
      assert.equal((await put(url, good)).status, 200);
      assert.deepEqual(await fs.readFile(file), good);
      const bad = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
      const again = await reserveReplace(srv, { filename: 'n.md', folder: 'p-note', content: bad, expect: await versionOf(file) });
      const r = await put(again.url, bad);
      assert.equal(r.status, 400, r.text);
      assert.deepEqual(await fs.readFile(file), good);
    });
  });

  describe('read-file gives the version to replace', () => {
    it('adds the sha256 and Last-Modified of the file read', async () => {
      const bytes = crypto.randomBytes(120);
      const { file } = await seed('rb/a.bin', bytes);
      const result = await callTool(srv, 'read-file', { filename: 'a.bin', folder: 'rb' });
      assert.ok(!result.isError, JSON.stringify(result));
      const texts = result.content.filter(c => c.type === 'text').map(c => c.text);
      assert.ok(texts.includes(`sha256: ${sha256(bytes)}`), texts.join('|'));
      assert.ok(texts.includes(`Last-Modified: ${(await fs.stat(file)).mtime.toISOString()}`), texts.join('|'));
      assert.equal(result.content[0].text, `rb/a.bin (120 bytes, application/octet-stream)`);
    });

    it('the values it gives are accepted by replace-file', async () => {
      const { file } = await seed('rb2/a.bin', crypto.randomBytes(80));
      const read = await callTool(srv, 'read-file', { filename: 'a.bin', folder: 'rb2' });
      const texts = read.content.filter(c => c.type === 'text').map(c => c.text);
      const expectedSha256 = texts.find(t => t.startsWith('sha256: ')).slice(8);
      const expectedMtime = texts.find(t => t.startsWith('Last-Modified: ')).slice(15);
      const content = crypto.randomBytes(81);
      const { url, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'rb2', content, expect: { expectedSha256, expectedMtime } });
      assert.ok(url, text);
      assert.equal((await put(url, content)).status, 200);
      assert.deepEqual(await fs.readFile(file), content);
    });
  });

  describe('the audit log', () => {
    it('records the reservation and the replacement with the hash that was replaced', async () => {
      const { expect } = await seed('au/a.bin', crypto.randomBytes(50));
      const content = crypto.randomBytes(51);
      const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'au', content, expect });
      assert.equal((await put(url, content)).status, 200);
      await sleep(50);
      const lines = srv.log().split('\n');
      assert.ok(lines.some(l => l.includes('AUDIT event=upload-reserved') && l.includes('mode=replace') && l.includes('path=au/a.bin')), 'upload-reserved');
      assert.ok(lines.some(l => l.includes('AUDIT event=upload-placed') && l.includes('mode=replace') && l.includes(`previous_sha256=${expect.expectedSha256}`)), 'upload-placed');
    });
  });
});

describe('replace-file and read-file with a file over the read limit', () => {
  let srv;
  before(async () => { srv = await startServer({ readMaxBytes: 1000 }); });
  after(async () => { await srv.stop(); });

  it('refuses the read but names the version, so the file can still be replaced', async () => {
    const bytes = crypto.randomBytes(2000);
    const file = path.join(srv.vaultDir, 'big.bin');
    await fs.writeFile(file, bytes);
    const read = await callTool(srv, 'read-file', { filename: 'big.bin' });
    assert.equal(read.isError, true);
    const text = read.content[0].text;
    assert.ok(text.includes('exceeds the 1000-byte read limit'), text);
    const stat = await fs.stat(file);
    assert.ok(text.includes(`sha256 ${sha256(bytes)}`), text);
    assert.ok(text.includes(`Last-Modified ${stat.mtime.toISOString()}`), text);
    const content = crypto.randomBytes(500);
    const { url, text: reserved } = await reserveReplace(srv, { filename: 'big.bin', content, expect: { expectedSha256: sha256(bytes), expectedMtime: stat.mtime.toISOString() } });
    assert.ok(url, reserved);
    assert.equal((await put(url, content)).status, 200);
  });
});

describe('replace-file edge cases', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  async function seed(rel, content) {
    const file = path.join(srv.vaultDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(file, past, past);
    return { file, expect: await versionOf(file) };
  }

  it('does not copy setuid, setgid or sticky bits onto the new file', async () => {
    const { file } = await seed('e-mode/a.bin', crypto.randomBytes(40));
    await fs.chmod(file, 0o6755);
    const content = crypto.randomBytes(41);
    const { url } = await reserveReplace(srv, { filename: 'a.bin', folder: 'e-mode', content, expect: await versionOf(file) });
    assert.equal((await put(url, content)).status, 200);
    assert.equal((await fs.stat(file)).mode & 0o7777, 0o755);
  });

  it('accepts the version hash in upper case', async () => {
    const { expect } = await seed('e-upper/a.bin', crypto.randomBytes(40));
    const content = crypto.randomBytes(41);
    const { url, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'e-upper', content, expect: { ...expect, expectedSha256: expect.expectedSha256.toUpperCase() } });
    assert.ok(url, text);
    const r = await put(url, content);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.previousSha256, expect.expectedSha256);
  });

  it('judges a note by the file really replaced: a non-note name linked to a note needs UTF-8', async () => {
    const note = await seed('e-link/n.md', '# old\n');
    await fs.symlink('n.md', path.join(srv.vaultDir, 'e-link/a.bin'));
    const bad = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
    const { url, text } = await reserveReplace(srv, { filename: 'a.bin', folder: 'e-link', content: bad, expect: note.expect });
    assert.ok(url, text);
    const r = await put(url, bad);
    assert.equal(r.status, 400, r.text);
    assert.equal(await fs.readFile(note.file, 'utf8'), '# old\n');
  });

  it('judges a note by the name asked for: a note name linked to a binary file needs UTF-8 too', async () => {
    const bin = await seed('e-link2/x.bin', crypto.randomBytes(30));
    await fs.symlink('x.bin', path.join(srv.vaultDir, 'e-link2/l.md'));
    const bad = Buffer.from([0xff, 0xfe, 0x00]);
    const { url, text } = await reserveReplace(srv, { filename: 'l.md', folder: 'e-link2', content: bad, expect: bin.expect });
    assert.ok(url, text);
    assert.equal((await put(url, bad)).status, 400);
  });

  it('refuses a link to a denied folder and a link to a protected binary file, at the reservation', async () => {
    const priv = await seed('private/secret.bin', crypto.randomBytes(30));
    const prot = await seed('protected/secret.bin', crypto.randomBytes(30));
    await fs.mkdir(path.join(srv.vaultDir, 'e-deny'), { recursive: true });
    await fs.symlink('../private/secret.bin', path.join(srv.vaultDir, 'e-deny/to-private.bin'));
    await fs.symlink('../protected/secret.bin', path.join(srv.vaultDir, 'e-deny/to-protected.bin'));
    const content = crypto.randomBytes(10);
    const a = await reserveReplace(srv, { filename: 'to-private.bin', folder: 'e-deny', content, expect: priv.expect });
    assert.equal(a.result.isError, true);
    assert.equal(a.text, 'Access denied');
    const b = await reserveReplace(srv, { filename: 'to-protected.bin', folder: 'e-deny', content, expect: prot.expect });
    assert.equal(b.result.isError, true);
    assert.ok(b.text.startsWith('Reading is restricted for'), b.text);
  });
});
