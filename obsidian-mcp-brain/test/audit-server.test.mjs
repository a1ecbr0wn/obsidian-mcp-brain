/**
 * Integration tests for the audit log and the logFile setting.
 * Spawns real server processes with their own vaults and ports (20300 and up).
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

let nextPort = 20300;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Waits until `check()` is true, or fails. */
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Starts a server process with a fresh vault.
 * @param {object} [extra] - Config fields merged over the defaults. `logFile: true` puts the
 *   log file in the test's folder.
 */
async function startServer(extra = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-test-'));
  const vaultDir = path.join(root, 'vault');
  await fs.mkdir(vaultDir);
  const logFile = path.join(root, 'server.log');
  const config = {
    listenPort: port,
    mcpBaseUrl: `http://127.0.0.1:${port}`,
    denyPaths: ['private'],
    uploadTempDir: path.join(root, 'staging'),
    vaults: { v: { path: vaultDir } },
    ...extra,
  };
  if (config.logFile === true) config.logFile = logFile;
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const proc = spawn('node', [SERVER_ENTRY], {
    env: { ...process.env, CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', c => { log += c.toString(); });
  proc.stderr.on('data', c => { log += c.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timeout\n${log}`)), 15_000);
    const check = setInterval(() => { if (log.includes('listening')) { clearInterval(check); clearTimeout(timer); resolve(); } }, 25);
    proc.on('exit', code => { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited early with code ${code}\n${log}`)); });
  });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  return {
    port, root, vaultDir, logFile, proc,
    log: () => log,
    /** The audit lines in the log, one string each. */
    audit: () => log.split('\n').filter(l => l.includes('AUDIT event=')),
    /** Waits for an audit line that satisfies `test`, and returns it (undefined if none comes). */
    async find(test, ms = 2000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const line = log.split('\n').find(l => l.includes('AUDIT event=') && test(l));
        if (line || Date.now() > deadline) return line;
        await sleep(25);
      }
    },
    /** Stops the server with SIGTERM and waits for it to go; the folder is kept. */
    async terminate() {
      if (proc.exitCode === null) proc.kill('SIGTERM');
      await exited;
    },
    async stop() {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await exited;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Starts a server that is expected to refuse its config; resolves with its exit code and output. */
async function startRefused(extra) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-test-'));
  await fs.mkdir(path.join(root, 'vault'));
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port, mcpBaseUrl: `http://127.0.0.1:${port}`, uploadTempDir: path.join(root, 'staging'),
    vaults: { v: { path: path.join(root, 'vault') } }, ...extra,
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', c => { out += c.toString(); });
  proc.stderr.on('data', c => { out += c.toString(); });
  const code = await new Promise(resolve => {
    proc.on('exit', resolve);
    setTimeout(() => { proc.kill('SIGKILL'); }, 10_000);
  });
  await fs.rm(root, { recursive: true, force: true });
  return { code, out };
}

function mcpPost(port, body, sid, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers };
    if (sid) h['mcp-session-id'] = sid;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: h, agent: false }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const msgs = [];
        for (const line of data.split('\n')) if (line.startsWith('data: ')) { try { msgs.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, msgs });
      });
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

async function openSession(srv, headers = {}) {
  const init = await mcpPost(srv.port, {
    jsonrpc: '2.0', id: '1', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  }, undefined, headers);
  const sid = init.headers['mcp-session-id'];
  assert.ok(sid, 'initialize should return a session id');
  return sid;
}

async function callTool(srv, name, args, { sid, headers = {} } = {}) {
  sid ??= await openSession(srv, headers);
  const r = await mcpPost(srv.port, {
    jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name, arguments: { vault: 'v', ...args } },
  }, sid, headers);
  return { result: r.msgs[0].result, sid };
}

/** One PUT to an upload URL. */
function put(urlStr, body, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(urlStr);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT', agent: false,
      headers: { 'Content-Length': body.length, ...headers } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', err => resolve(err));
    req.end(body);
  });
}

async function reserveUpload(srv, filename, content, headers = {}) {
  const { result } = await callTool(srv, 'upload-file', { filename, size: content.length, sha256: sha256(content) }, { headers });
  const url = result.content[0].text.match(/https?:\/\/\S+\/up\/[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(url, result.content[0].text);
  return url;
}

// ── audit events ────────────────────────────────────────────────────────────

describe('the audit log', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it('logs the start of the server with its version, address and settings', () => {
    const line = srv.audit().find(l => l.includes('event=start'));
    assert.ok(line, srv.log());
    assert.match(line, /version=\d+\.\d+\.\d+/);
    assert.ok(line.includes(`listen=127.0.0.1:${srv.port}`), line);
    assert.ok(line.includes('auth=off'), line);
    assert.ok(line.includes('logfile=no'), line);
  });

  it('logs a login when a client opens a session, with its address and host', async () => {
    const sid = await openSession(srv, { Host: 'brain.example.test' });
    const line = await srv.find(l => l.includes('event=login') && l.includes(`sid=${sid.slice(0, 8)}`));
    assert.ok(line, srv.log());
    assert.ok(line.includes('user=-'), line);
    assert.ok(line.includes('addr=127.0.0.1'), line);
    assert.ok(line.includes('host=brain.example.test'), line);
  });

  it('logs every tool call with its vault and target, and then its outcome', async () => {
    const { sid } = await callTool(srv, 'list-notes', { path: 'inbox' });
    const mine = l => l.includes(`sid=${sid.slice(0, 8)}`);
    const call = await srv.find(l => mine(l) && l.includes('event=tool '));
    assert.ok(call, srv.log());
    assert.ok(call.includes('tool=list-notes') && call.includes('vault=v') && call.includes('path=inbox'), call);
    const result = await srv.find(l => mine(l) && l.includes('event=tool-result'));
    assert.ok(result, srv.log());
    assert.ok(result.includes('tool=list-notes') && result.includes('outcome=ok'), result);
    assert.match(result, /duration=\d+/);
  });

  it('logs a tool call that fails as an error', async () => {
    const { result, sid } = await callTool(srv, 'read-note', { filename: 'missing.md' });
    assert.equal(result.isError, true);
    const line = await srv.find(l => l.includes('event=tool-result') && l.includes(`sid=${sid.slice(0, 8)}`));
    assert.ok(line && line.includes('outcome=error'), line);
  });

  it('logs a call to a tool that touches no vault', async () => {
    const { sid } = await callTool(srv, 'list-vaults', {});
    assert.ok(await srv.find(l => l.includes('event=tool ') && l.includes('tool=list-vaults') && l.includes(`sid=${sid.slice(0, 8)}`)), srv.log());
    assert.ok(await srv.find(l => l.includes('event=tool-result') && l.includes('tool=list-vaults') && l.includes(`sid=${sid.slice(0, 8)}`)), srv.log());
  });

  it('logs a call that a deny rule refused as denied, with the reason', async () => {
    const { result, sid } = await callTool(srv, 'list-notes', { path: 'private' });
    assert.equal(result.isError, true);
    const mine = l => l.includes(`sid=${sid.slice(0, 8)}`);
    const denied = await srv.find(l => mine(l) && l.includes('event=denied'));
    assert.ok(denied, srv.log());
    assert.ok(denied.includes('tool=list-notes') && denied.includes('reason='), denied);
    assert.ok(!srv.audit().some(l => mine(l) && l.includes('event=tool-result')), 'a denied call has no result line');
  });

  it('never logs note text, a query, or a note that was written', async () => {
    const secret = `SECRET-${crypto.randomBytes(6).toString('hex')}`;
    await callTool(srv, 'create-note', { filename: 'audit-secret.md', content: `# ${secret}` });
    await callTool(srv, 'search-vault', { query: secret });
    await sleep(100);
    assert.ok(!srv.log().includes(secret), 'note text and queries must not be logged');
    assert.ok(await srv.find(l => l.includes('tool=create-note') && l.includes('filename=audit-secret.md')), srv.log());
  });

  it('ignores X-Forwarded-Host when no proxy is trusted', async () => {
    const sid = await openSession(srv, { Host: 'internal.test', 'X-Forwarded-Host': 'forged.test' });
    const line = await srv.find(l => l.includes('event=login') && l.includes(`sid=${sid.slice(0, 8)}`));
    assert.ok(line.includes('host=internal.test'), line);
  });

  it('cannot be made to forge a line or a field by a client', async () => {
    const sid = await openSession(srv, { Host: 'a.test' });
    await callTool(srv, 'read-note', { filename: 'x.md event=forged\r\nAUDIT event=login user=root' }, { sid });
    await sleep(100);
    const tokens = srv.log().split('\n').filter(l => l.includes('AUDIT')).flatMap(l => l.split(' '));
    assert.ok(!tokens.includes('user=root'), 'a value must not add a field');
    for (const line of srv.audit()) {
      assert.ok(line.split(' ').filter(t => t.startsWith('event=')).length === 1, `one event per line: ${line}`);
    }
    assert.ok(!srv.log().split('\n').some(l => l.startsWith('AUDIT')), 'a value must not start a line');
  });
});

// ── denials by the binary read rules ────────────────────────────────────────

describe('the audit log of a call refused by denyBinaryPaths', () => {
  let srv;
  before(async () => {
    srv = await startServer({ denyBinaryPaths: ['**/*.pdf'] });
    await fs.writeFile(path.join(srv.vaultDir, 'locked.pdf'), '%PDF-1.4');
  });
  after(async () => { await srv.stop(); });

  it('logs a protected file that read-file refused as denied', async () => {
    const { result, sid } = await callTool(srv, 'read-file', { filename: 'locked.pdf' });
    assert.equal(result.isError, true);
    const line = await srv.find(l => l.includes('event=denied') && l.includes(`sid=${sid.slice(0, 8)}`));
    assert.ok(line && line.includes('tool=read-file') && line.includes('filename=locked.pdf'), srv.log());
  });
});

// ── the host with a trusted proxy ───────────────────────────────────────────

describe('the audit log behind a trusted proxy', () => {
  let srv;
  before(async () => { srv = await startServer({ trustedProxies: ['127.0.0.1', '::1'] }); });
  after(async () => { await srv.stop(); });

  it('logs the forwarded host and the forwarded address', async () => {
    const sid = await openSession(srv, { Host: 'internal.test', 'X-Forwarded-Host': 'brain.example.test', 'X-Forwarded-For': '203.0.113.9' });
    const line = await srv.find(l => l.includes('event=login') && l.includes(`sid=${sid.slice(0, 8)}`));
    assert.ok(line.includes('host=brain.example.test'), line);
    assert.ok(line.includes('addr=203.0.113.9'), line);
  });
});

// ── uploads ─────────────────────────────────────────────────────────────────

describe('the audit log of uploads', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });
  const content = crypto.randomBytes(100);

  it('logs a reserved upload with its destination, size, address and host', async () => {
    await reserveUpload(srv, 'reserved.bin', content, { Host: 'brain.example.test' });
    const line = await srv.find(l => l.includes('event=upload-reserved'));
    assert.ok(line, srv.log());
    for (const part of ['vault=v', 'path=reserved.bin', 'size=100', 'addr=127.0.0.1', 'host=brain.example.test', 'user=-']) {
      assert.ok(line.includes(part), `${part} in ${line}`);
    }
  });

  it('logs the upload that places the file, with the address and host that sent it', async () => {
    const url = await reserveUpload(srv, 'placed.bin', content);
    assert.equal(await put(url, content, { Host: 'upload.example.test' }), 201);
    const line = await srv.find(l => l.includes('event=upload-placed'));
    assert.ok(line, srv.log());
    for (const part of ['vault=v', 'path=placed.bin', 'bytes=100', `sha256=${sha256(content)}`, 'addr=127.0.0.1', 'host=upload.example.test']) {
      assert.ok(line.includes(part), `${part} in ${line}`);
    }
  });

  it('logs the request for an upload with its host and address, and never the URL', async () => {
    const url = await reserveUpload(srv, 'requested.bin', content);
    await put(url, content, { Host: 'seen.example.test' });
    const token = url.split('/up/')[1];
    await until(() => srv.log().includes('seen.example.test'), 'the request line');
    const line = srv.log().split('\n').find(l => l.includes('PUT /up/<redacted>') && l.includes('seen.example.test'));
    assert.ok(line, srv.log());
    assert.ok(line.includes('addr=127.0.0.1'), line);
    assert.ok(!srv.log().includes(token), 'the token must not be logged');
  });

  it('adds the host to the line for a refused upload', async () => {
    const url = await reserveUpload(srv, 'refused.bin', content);
    assert.equal(await put(url, Buffer.alloc(100, 1), { Host: 'refused.example.test' }), 422);
    await until(() => srv.log().includes('upload refused (422)'), 'the refusal line');
    const line = srv.log().split('\n').find(l => l.includes('upload refused (422)'));
    assert.ok(line && line.includes('host=refused.example.test'), line);
  });

  it('does not log a reservation that was refused', async () => {
    const before = srv.audit().filter(l => l.includes('event=upload-reserved')).length;
    await callTool(srv, 'upload-file', { filename: 'x.bin', size: 0, sha256: 'bad' });
    assert.equal(srv.audit().filter(l => l.includes('event=upload-reserved')).length, before);
  });
});

// ── the log file ────────────────────────────────────────────────────────────

describe('logFile', () => {
  it('is off by default: the start line says so', async () => {
    const srv = await startServer();
    try { assert.ok(srv.audit().some(l => l.includes('event=start') && l.includes('logfile=no'))); } finally { await srv.stop(); }
  });

  it('receives every line the server logs, owner-only, while stdout still gets them', async () => {
    const srv = await startServer({ logFile: true });
    try {
      await callTool(srv, 'list-vaults', {});
      await sleep(100);
      const written = await fs.readFile(srv.logFile, 'utf8');
      assert.ok(written.includes('listening on 127.0.0.1'), written);
      assert.ok(written.includes('AUDIT event=start'), written);
      assert.ok(written.includes('logfile=yes'), written);
      assert.ok(written.includes('tool=list-vaults'), written);
      assert.ok(srv.log().includes('tool=list-vaults'), 'stdout still receives the log');
      assert.equal((await fs.stat(srv.logFile)).mode & 0o777, 0o600);
      assert.equal(written.trimEnd().split('\n').length, srv.log().trimEnd().split('\n').length, 'the same lines');
    } finally { await srv.stop(); }
  });

  it('appends to a file that already holds earlier lines', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-pre-'));
    const file = path.join(root, 'pre.log');
    await fs.writeFile(file, 'earlier line\n');
    const srv = await startServer({ logFile: file });
    try {
      const written = await fs.readFile(file, 'utf8');
      assert.ok(written.startsWith('earlier line\n'), written);
      assert.ok(written.includes('AUDIT event=start'), written);
    } finally { await srv.stop(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('is reopened on SIGHUP, so a moved file is replaced', async () => {
    const srv = await startServer({ logFile: true });
    try {
      await fs.rename(srv.logFile, `${srv.logFile}.1`);
      srv.proc.kill('SIGHUP');
      await until(() => srv.log().includes('log file reopened'), 'the reopen line');
      await callTool(srv, 'list-vaults', {});
      await until(async () => (await fs.readFile(srv.logFile, 'utf8').catch(() => '')).includes('tool=list-vaults'), 'the new file');
      assert.ok(!(await fs.readFile(`${srv.logFile}.1`, 'utf8')).includes('tool=list-vaults'), 'the moved file gets nothing more');
    } finally { await srv.stop(); }
  });

  it('records the stop of the server on SIGTERM', async () => {
    const srv = await startServer({ logFile: true });
    try {
      await srv.terminate();
      assert.equal(srv.proc.exitCode, 0);
      assert.ok((await fs.readFile(srv.logFile, 'utf8')).includes('AUDIT event=stop'));
      assert.ok(srv.audit().some(l => l.includes('event=stop') && l.includes('signal=SIGTERM')), srv.log());
    } finally { await srv.stop(); }
  });

  it('records the stop of the server on SIGINT', async () => {
    const srv = await startServer();
    try {
      srv.proc.kill('SIGINT');
      await until(() => srv.audit().some(l => l.includes('event=stop') && l.includes('signal=SIGINT')), 'the stop line');
    } finally { await srv.stop(); }
  });

  for (const [what, value, message] of [
    ['a relative path', 'server.log', '"logFile" must be an absolute path'],
    ['an empty string', '', '"logFile" must be a non-empty string'],
    ['a number', 5, '"logFile" must be a non-empty string'],
    ['a folder that does not exist', '/nonexistent-audit-folder/server.log', 'Cannot open "logFile"'],
  ]) {
    it(`refuses ${what}, and the server does not start`, async () => {
      const r = await startRefused({ logFile: value });
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes(message), r.out);
    });
  }
});
