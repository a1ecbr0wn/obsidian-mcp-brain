/**
 * Tests for the replace-binary-file skill's helper script (skills/replace-binary-file/scripts/replace-binary-file.sh).
 * `send` is run against a small local server that answers like the real PUT /up/<token> endpoint,
 * and once against a real server, so what is checked is the script's own behaviour: its output,
 * its exit status, what it checks in the reply, and that the upload token is never printed.
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
const SCRIPT = path.join(__dirname, '..', '..', 'skills', 'replace-binary-file', 'scripts', 'replace-binary-file.sh');
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCde'; // 43 characters

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function run(args) {
  return new Promise((resolve) => {
    const proc = spawn('/bin/sh', [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}

async function fakeServer(reply) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const { status, json } = reply(Buffer.concat(chunks));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/up/${TOKEN}`, close: () => new Promise(r => server.close(r)) };
}

function rpc(port, body, sid) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (sid) headers['mcp-session-id'] = sid;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, agent: false }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        const line = text.split('\n').find(l => l.startsWith('data:'));
        resolve({ sid: res.headers['mcp-session-id'], msg: JSON.parse(line ? line.slice(5) : text) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('replace-binary-file.sh prepare and send', () => {
  let dir;
  let file;
  const content = crypto.randomBytes(5000);
  const OLD = 'b'.repeat(64);

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-skill-'));
    file = path.join(dir, 'new.bin');
    await fs.writeFile(file, content);
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const good = (over = {}) => (body) => ({
    status: 200,
    json: { path: 'a/new.bin', bytes: body.length, sha256: sha256(body), replaced: true, previousSha256: OLD, trashedAs: '.trash/new.bin', ...over },
  });

  it('prepare prints the name, size and hash of the new file', async () => {
    const r = await run(['prepare', file]);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.stdout, `filename=new.bin\nsize=5000\nsha256=${sha256(content)}\n`);
  });

  it('hashes a file whose name has a backslash or a newline in it', async () => {
    for (const name of ['back\\slash.bin', 'new\nline.bin']) {
      const odd = path.join(dir, name);
      const bytes = crypto.randomBytes(300);
      await fs.writeFile(odd, bytes);
      const r = await run(['prepare', odd]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, new RegExp(`^sha256=${sha256(bytes)}$`, 'm'), name);
    }
  });

  it('prepare refuses a missing file and a directory', async () => {
    assert.equal((await run(['prepare', path.join(dir, 'nope')])).code, 1);
    assert.equal((await run(['prepare', dir])).code, 1);
  });

  it('send reports the replacement, the old version and where it went, and never prints the token', async () => {
    const srv = await fakeServer(good());
    try {
      const r = await run(['send', file, srv.url, OLD]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, /^replaced a\/new\.bin \(5000 bytes, sha256 [0-9a-f]{64}\), verified against the local file; the old version \(sha256 b{64}\) is in \.trash\/new\.bin$/m);
      assert.ok(!r.all.includes(TOKEN));
    } finally { await srv.close(); }
  });

  it('send accepts the old hash in upper case', async () => {
    const srv = await fakeServer(good());
    try {
      assert.equal((await run(['send', file, srv.url, OLD.toUpperCase()])).code, 0);
    } finally { await srv.close(); }
  });

  it('send fails when the server replaced a different version', async () => {
    const srv = await fakeServer(good({ previousSha256: 'c'.repeat(64) }));
    try {
      const r = await run(['send', file, srv.url, OLD]);
      assert.equal(r.code, 1);
      assert.match(r.all, /replaced a different version/);
    } finally { await srv.close(); }
  });

  it('send fails when the reply does not say the file was replaced', async () => {
    const srv = await fakeServer(good({ replaced: false }));
    try {
      const r = await run(['send', file, srv.url, OLD]);
      assert.equal(r.code, 1);
      assert.match(r.all, /did not say that the file was replaced/);
    } finally { await srv.close(); }
  });

  it('send fails when the server stored other bytes than the local file', async () => {
    const srv = await fakeServer(good({ sha256: 'd'.repeat(64) }));
    try {
      const r = await run(['send', file, srv.url, OLD]);
      assert.equal(r.code, 1);
      assert.match(r.all, /sha256 does not match/);
    } finally { await srv.close(); }
  });

  it('send shows the server\'s own explanation of a refusal, with the status', async () => {
    const srv = await fakeServer(() => ({ status: 409, json: { error: 'the file has changed since it was read; read it again with read-binary-file and request a new URL' } }));
    try {
      const r = await run(['send', file, srv.url, OLD]);
      assert.equal(r.code, 1);
      assert.match(r.all, /answered 409: the file has changed since it was read/);
      assert.ok(!r.all.includes(TOKEN));
    } finally { await srv.close(); }
  });

  it('send needs the hash of the version being replaced, and a valid one', async () => {
    const srv = await fakeServer(good());
    try {
      assert.equal((await run(['send', file, srv.url])).code, 2);
      for (const bad of ['abc', 'z'.repeat(64), OLD + 'b']) {
        const r = await run(['send', file, srv.url, bad]);
        assert.equal(r.code, 1, bad);
        assert.match(r.all, /SHA-256 of the version being replaced/);
      }
    } finally { await srv.close(); }
  });

  it('send refuses a URL that is not an upload URL', async () => {
    const r = await run(['send', file, 'http://127.0.0.1:1/other', OLD]);
    assert.equal(r.code, 1);
    assert.match(r.all, /must be the one returned by replace-binary-file/);
  });
});

describe('replace-binary-file skill against a real server', () => {
  let root;
  let proc;
  const port = 20560;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-skill-e2e-'));
    await fs.mkdir(path.join(root, 'vault'));
    const configPath = path.join(root, 'cfg.json');
    await fs.writeFile(configPath, JSON.stringify({
      listenPort: port, mcpBaseUrl: `http://127.0.0.1:${port}`, uploadTempDir: path.join(root, 'staging'),
      vaults: { v: { path: path.join(root, 'vault') } },
    }));
    proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let log = '';
      const onData = c => { log += c; if (log.includes('listening')) resolve(); };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', code => reject(new Error(`server exited early (${code})\n${log}`)));
      setTimeout(() => reject(new Error('server startup timeout')), 15_000);
    });
  });
  after(async () => {
    if (proc.exitCode === null) await new Promise(r => { proc.once('exit', r); proc.kill(); });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads the version, prepares, reserves and sends: the file is replaced and the old one is in .trash', async () => {
    const oldBytes = crypto.randomBytes(30_000);
    const vaultFile = path.join(root, 'vault', 'docs', 'report.pdf');
    await fs.mkdir(path.dirname(vaultFile), { recursive: true });
    await fs.writeFile(vaultFile, oldBytes);

    const init = await rpc(port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const call = (id, name, args) => rpc(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { vault: 'v', ...args } } }, init.sid);

    const read = (await call(2, 'read-binary-file', { folder: 'docs', filename: 'report.pdf' })).msg.result.content;
    const texts = read.filter(c => c.type === 'text').map(c => c.text);
    const expectedSha256 = texts.find(t => t.startsWith('sha256: ')).slice(8);
    const expectedMtime = texts.find(t => t.startsWith('Last-Modified: ')).slice(15);

    const newBytes = crypto.randomBytes(35_000);
    const src = path.join(root, 'report.pdf');
    await fs.writeFile(src, newBytes);
    const prep = await run(['prepare', src]);
    assert.equal(prep.code, 0, prep.all);
    const field = (name) => prep.stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))[1];

    const reserved = await call(3, 'replace-binary-file', {
      folder: 'docs', filename: field('filename'), size: Number(field('size')), sha256: field('sha256'), expectedSha256, expectedMtime,
    });
    const text = reserved.msg.result.content[0].text;
    const url = text.match(/https?:\/\/\S+\/up\/[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(url, text);

    const sent = await run(['send', src, url, expectedSha256]);
    assert.equal(sent.code, 0, sent.all);
    assert.match(sent.stdout, /replaced docs\/report\.pdf/);
    assert.ok(!sent.all.includes(url.split('/up/')[1]));
    assert.deepEqual(await fs.readFile(vaultFile), newBytes);
    const trashed = sent.stdout.match(/is in (\S+)\s*$/)[1];
    assert.deepEqual(await fs.readFile(path.join(root, 'vault', trashed)), oldBytes);

    const again = await run(['send', src, url, expectedSha256]);
    assert.notEqual(again.code, 0);
    assert.match(again.all, /404/);
  });
});
