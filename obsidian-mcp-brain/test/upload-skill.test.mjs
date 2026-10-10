/**
 * Tests for the upload-binary-file skill's helper script (skills/upload-binary-file/scripts/upload-binary-file.sh).
 * `send` is run against a small local HTTP server that answers like the real PUT /up/<token>
 * endpoint, so what is checked is the script's own behaviour: its output, its exit status, and
 * that the upload token never appears in anything it prints.
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
const SCRIPT = path.join(__dirname, '..', '..', 'skills', 'upload-binary-file', 'scripts', 'upload-binary-file.sh');
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCde'; // 43 characters

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Runs the script and collects its output. */
function run(args, env = {}, shell = '/bin/sh') {
  return new Promise((resolve) => {
    const proc = spawn(shell, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}

/** A server that records the PUT it receives and answers with whatever `reply` says. */
async function fakeServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, body });
      const { status, json } = reply(body, req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/up/${TOKEN}`,
    close: () => new Promise(r => server.close(r)),
  };
}

const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');

/** One JSON-RPC call to a running server, resolving with the first message's result. */
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

// The whole workflow an agent follows, against a real server: prepare, upload-binary-file, send.
describe('upload-binary-file skill against a real server', () => {
  let root;
  let proc;
  const port = 19900;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-skill-e2e-'));
    await fs.mkdir(path.join(root, 'vault'));
    const configPath = path.join(root, 'cfg.json');
    await fs.writeFile(configPath, JSON.stringify({
      listenPort: port,
      mcpBaseUrl: `http://127.0.0.1:${port}`,
      uploadTempDir: path.join(root, 'staging'),
      trustedProxies: [],
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

  it('puts a file in the vault and reports it verified', async () => {
    const data = crypto.randomBytes(40_000);
    const src = path.join(root, 'report.pdf');
    await fs.writeFile(src, data);

    const prep = await run(['prepare', src]);
    assert.equal(prep.code, 0, prep.all);
    const field = (name) => prep.stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))[1];

    const init = await rpc(port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const call = await rpc(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'upload-binary-file', arguments: { vault: 'v', folder: 'inbox', filename: field('filename'), size: Number(field('size')), sha256: field('sha256') } },
    }, init.sid);
    const text = call.msg.result.content[0].text;
    const url = text.match(/https?:\/\/\S+\/up\/[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(url, text);

    const sent = await run(['send', src, url]);
    assert.equal(sent.code, 0, sent.all);
    assert.match(sent.stdout, /uploaded inbox\/report\.pdf/);
    assert.ok(!sent.all.includes(url.split('/up/')[1]));
    assert.deepEqual(await fs.readFile(path.join(root, 'vault', 'inbox', 'report.pdf')), data);

    // The URL is single-use: a second send is refused and says so.
    const again = await run(['send', src, url]);
    assert.notEqual(again.code, 0);
    assert.match(again.all, /404/);
  });
});

describe('upload-binary-file.sh', () => {
  let dir;
  let file;
  const content = crypto.randomBytes(5000);

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-skill-'));
    file = path.join(dir, 'sample scan.pdf');
    await fs.writeFile(file, content);
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  describe('prepare', () => {
    it('prints the file name, size and sha256', async () => {
      const r = await run(['prepare', file]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, /^filename=sample scan\.pdf$/m);
      assert.match(r.stdout, /^size=5000$/m);
      assert.match(r.stdout, new RegExp(`^sha256=${sha256(content)}$`, 'm'));
    });

    it('handles an empty file', async () => {
      const empty = path.join(dir, 'empty.bin');
      await fs.writeFile(empty, '');
      const r = await run(['prepare', empty]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, /^size=0$/m);
      assert.match(r.stdout, new RegExp(`^sha256=${sha256(Buffer.alloc(0))}$`, 'm'));
    });

    it('rejects a missing file', async () => {
      const r = await run(['prepare', path.join(dir, 'nope.pdf')]);
      assert.notEqual(r.code, 0);
      assert.match(r.all, /not a regular file|no such file|cannot read/i);
    });

    it('rejects a directory', async () => {
      const r = await run(['prepare', dir]);
      assert.notEqual(r.code, 0);
      assert.match(r.all, /not a regular file/i);
    });

    it('rejects an unreadable file', async (t) => {
      if (process.getuid?.() === 0) return t.skip('root can read any file');
      const locked = path.join(dir, 'locked.bin');
      await fs.writeFile(locked, 'x');
      await fs.chmod(locked, 0o000);
      const r = await run(['prepare', locked]);
      assert.notEqual(r.code, 0);
      assert.match(r.all, /cannot read|not readable/i);
    });

    it('falls back to shasum when sha256sum is absent', async (t) => {
      // A PATH holding only shasum (plus the basics the script needs) hides sha256sum.
      const bin = path.join(dir, 'bin');
      await fs.mkdir(bin);
      const which = async (name) => {
        for (const d of (process.env.PATH ?? '').split(':')) {
          try { await fs.access(path.join(d, name)); return path.join(d, name); } catch { /* next */ }
        }
        return null;
      };
      const shasum = await which('shasum');
      if (!shasum) return t.skip('shasum not installed');
      for (const name of ['shasum', 'wc', 'perl']) {
        const real = await which(name);
        if (real) await fs.symlink(real, path.join(bin, name));
      }
      const r = await run(['prepare', file], { PATH: bin });
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, new RegExp(`^sha256=${sha256(content)}$`, 'm'));
    });

    it('falls back to openssl when sha256sum and shasum are absent', async (t) => {
      const bin = path.join(dir, 'openssl-bin');
      await fs.mkdir(bin);
      for (const name of ['openssl', 'wc']) {
        for (const d of (process.env.PATH ?? '').split(':')) {
          try {
            await fs.access(path.join(d, name));
            await fs.symlink(path.join(d, name), path.join(bin, name));
            break;
          } catch { /* next */ }
        }
      }
      try { await fs.access(path.join(bin, 'openssl')); } catch { return t.skip('openssl not installed'); }
      const r = await run(['prepare', file], { PATH: bin });
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, new RegExp(`^sha256=${sha256(content)}$`, 'm'));
    });

    it('runs under dash, the strictest common /bin/sh', async (t) => {
      try { await fs.access('/usr/bin/dash'); } catch { return t.skip('dash not installed'); }
      const r = await run(['prepare', file], {}, '/usr/bin/dash');
      assert.equal(r.code, 0, r.all);
      assert.match(r.stdout, new RegExp(`^sha256=${sha256(content)}$`, 'm'));
    });

    it('fails clearly when no hashing tool is available', async () => {
      const bin = path.join(dir, 'empty-bin');
      await fs.mkdir(bin);
      const r = await run(['prepare', file], { PATH: bin });
      assert.notEqual(r.code, 0);
      assert.match(r.all, /sha256sum|shasum|openssl/);
    });
  });

  describe('send', () => {
    it('uploads the file and reports success', async () => {
      const srv = await fakeServer((body) => ({ status: 201, json: { path: 'a/b.pdf', bytes: body.length, sha256: sha256(body) } }));
      try {
        const r = await run(['send', file, srv.url]);
        assert.equal(r.code, 0, r.all);
        assert.match(r.stdout, /uploaded/i);
        assert.match(r.stdout, /a\/b\.pdf/);
        assert.equal(srv.seen.length, 1);
        assert.equal(srv.seen[0].method, 'PUT');
        assert.deepEqual(srv.seen[0].body, content);
      } finally { await srv.close(); }
    });

    it('never prints the token', async () => {
      const ok = await fakeServer((body) => ({ status: 201, json: { path: 'a.pdf', bytes: body.length, sha256: sha256(body) } }));
      const bad = await fakeServer(() => ({ status: 404, json: { error: 'not found' } }));
      try {
        for (const srv of [ok, bad]) {
          const r = await run(['send', file, srv.url]);
          assert.ok(!r.all.includes(TOKEN), `token leaked:\n${r.all}`);
        }
      } finally { await ok.close(); await bad.close(); }
    });

    it('reports a server refusal with its status and message, and exits non-zero', async () => {
      const srv = await fakeServer(() => ({ status: 422, json: { error: 'sha256 does not match the declared hash' } }));
      try {
        const r = await run(['send', file, srv.url]);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /422/);
        assert.match(r.all, /sha256 does not match/);
      } finally { await srv.close(); }
    });

    it('reports a reply whose hash differs from the local file', async () => {
      const srv = await fakeServer((body) => ({ status: 201, json: { path: 'a.pdf', bytes: body.length, sha256: 'f'.repeat(64) } }));
      try {
        const r = await run(['send', file, srv.url]);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /does not match/i);
      } finally { await srv.close(); }
    });

    it('reports a reply whose byte count differs from the local file', async () => {
      const srv = await fakeServer((body) => ({ status: 201, json: { path: 'a.pdf', bytes: body.length - 1, sha256: sha256(body) } }));
      try {
        const r = await run(['send', file, srv.url]);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /bytes/i);
      } finally { await srv.close(); }
    });

    it('fails when the server cannot be reached, without printing the token', async () => {
      const r = await run(['send', file, `http://127.0.0.1:1/up/${TOKEN}`]);
      assert.notEqual(r.code, 0);
      assert.ok(!r.all.includes(TOKEN), r.all);
    });

    it('rejects a missing file before contacting the server', async () => {
      const srv = await fakeServer(() => ({ status: 201, json: {} }));
      try {
        const r = await run(['send', path.join(dir, 'nope.pdf'), srv.url]);
        assert.notEqual(r.code, 0);
        assert.equal(srv.seen.length, 0);
      } finally { await srv.close(); }
    });
  });

  describe('usage', () => {
    it('shows usage and exits 2 with no arguments', async () => {
      const r = await run([]);
      assert.equal(r.code, 2);
      assert.match(r.all, /usage/i);
    });

    it('exits 2 for an unknown subcommand', async () => {
      const r = await run(['frobnicate', file]);
      assert.equal(r.code, 2);
    });

    it('exits 2 when send has no URL', async () => {
      const r = await run(['send', file]);
      assert.equal(r.code, 2);
    });
  });
});
