/**
 * Integration tests for DELETE /mcp and the sessionTimeoutSeconds setting.
 * Spawns real server processes with their own vaults and ports (20400 and up). The idle timeout
 * itself is at least 60 seconds, so its rules are tested in sessions.test.mjs with a fake clock.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');

let nextPort = 20400;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Starts a server with a fresh vault. */
async function startServer(extra = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-test-'));
  await fs.mkdir(path.join(root, 'vault'));
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port, mcpBaseUrl: `http://127.0.0.1:${port}`, uploadTempDir: path.join(root, 'staging'),
    vaults: { v: { path: path.join(root, 'vault') } }, ...extra,
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', c => { log += c.toString(); });
  proc.stderr.on('data', c => { log += c.toString(); });
  const exited = new Promise(resolve => proc.once('exit', code => resolve(code)));
  const started = await Promise.race([
    (async () => { await until(() => log.includes('listening'), 'the server to listen', 15_000); return true; })(),
    exited.then(code => { throw new Error(`server exited early with code ${code}\n${log}`); }),
  ]);
  assert.ok(started);
  return {
    port, log: () => log,
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-test-'));
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
  const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 6000);
  const code = await new Promise(resolve => proc.on('exit', resolve));
  clearTimeout(timer);
  await fs.rm(root, { recursive: true, force: true });
  return { code, out };
}

/** One request to /mcp. Resolves with {status, headers, msgs}. */
function mcp(port, { method = 'POST', body, sid, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const h = { ...headers };
    if (bodyStr) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(bodyStr); }
    if (sid) h['mcp-session-id'] = sid;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method, headers: h, agent: false }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const msgs = [];
        for (const line of data.split('\n')) if (line.startsWith('data: ')) { try { msgs.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, msgs, text: data });
      });
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

const INIT = { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } };
const PING = { jsonrpc: '2.0', id: '2', method: 'ping' };

async function openSession(srv) {
  const r = await mcp(srv.port, { body: INIT });
  const sid = r.headers['mcp-session-id'];
  assert.ok(sid, 'initialize should return a session id');
  return sid;
}

/** Opens the notification stream of a session; resolves with a handle that says when it ends. */
function openStream(port, sid) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'GET', headers: { 'mcp-session-id': sid }, agent: false }, res => {
      let ended = false;
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      res.resume();
      resolve({ status: res.statusCode, ended: () => ended, destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('DELETE /mcp', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it('removes the session and answers 204; a repeat is 404', async () => {
    const sid = await openSession(srv);
    assert.equal((await mcp(srv.port, { body: PING, sid })).status, 200);
    assert.equal((await mcp(srv.port, { method: 'DELETE', sid })).status, 204);
    assert.equal((await mcp(srv.port, { method: 'DELETE', sid })).status, 404);
  });

  it('makes the next request on that session 404, and a new initialize works', async () => {
    const sid = await openSession(srv);
    await mcp(srv.port, { method: 'DELETE', sid });
    assert.equal((await mcp(srv.port, { body: PING, sid })).status, 404);
    assert.equal((await mcp(srv.port, { method: 'GET', sid })).status, 404);
    assert.ok(await openSession(srv));
  });

  it('answers 404 for an unknown session id, and for none', async () => {
    assert.equal((await mcp(srv.port, { method: 'DELETE', sid: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await mcp(srv.port, { method: 'DELETE' })).status, 404);
  });

  it('ends the notification stream of the session', async () => {
    const sid = await openSession(srv);
    const stream = await openStream(srv.port, sid);
    assert.equal(stream.status, 200);
    assert.equal((await mcp(srv.port, { method: 'DELETE', sid })).status, 204);
    await until(() => stream.ended(), 'the stream to end');
  });

  it('leaves another session alone', async () => {
    const a = await openSession(srv);
    const b = await openSession(srv);
    await mcp(srv.port, { method: 'DELETE', sid: a });
    assert.equal((await mcp(srv.port, { body: PING, sid: b })).status, 200);
  });

  it('logs the end of the session', async () => {
    const sid = await openSession(srv);
    await mcp(srv.port, { method: 'DELETE', sid });
    await until(() => srv.log().split('\n').some(l => l.includes('AUDIT event=session-end') && l.includes(`sid=${sid.slice(0, 8)}`)), 'the session-end line');
  });

  it('still answers 405 to the other methods', async () => {
    const sid = await openSession(srv);
    assert.equal((await mcp(srv.port, { method: 'PUT', sid, body: PING })).status, 405);
    assert.equal((await mcp(srv.port, { method: 'PATCH', sid })).status, 405);
  });
});

describe('a session that is used keeps working', () => {
  let srv;
  before(async () => { srv = await startServer({ sessionTimeoutSeconds: 60 }); });
  after(async () => { await srv.stop(); });

  it('answers requests and reconnects its stream well within the timeout', async () => {
    const sid = await openSession(srv);
    const first = await openStream(srv.port, sid);
    first.destroy();
    await sleep(100);
    const second = await openStream(srv.port, sid);
    assert.equal(second.status, 200);
    assert.equal((await mcp(srv.port, { body: PING, sid })).status, 200);
    second.destroy();
  });
});

describe('sessionTimeoutSeconds', () => {
  for (const bad of [59, 0, -1, 60.5, '1800', true, {}, [60]]) {
    it(`refuses ${JSON.stringify(bad)}, and the server does not start`, async () => {
      const r = await startRefused({ sessionTimeoutSeconds: bad });
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes('"sessionTimeoutSeconds" must be a whole number of at least 60'), r.out);
    });
  }

  for (const ok of [60, 1800, 86400]) {
    it(`accepts ${ok}`, async () => {
      const srv = await startServer({ sessionTimeoutSeconds: ok });
      await srv.stop();
    });
  }
});
