/**
 * Integration tests for upload-binary-file and PUT /up/<token>.
 * Spawns real server processes with their own vaults, staging folders and ports
 * (19750 and up), and uses real HTTP requests, so what is tested is what runs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultUploadTempDir } from '../lib/uploads.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');

let nextPort = 19750;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── harness ─────────────────────────────────────────────────────────────────

/**
 * Starts a server process with a fresh vault and staging folder.
 * @param {object} [extra] - Config fields merged over the defaults.
 */
async function startServer(extra = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
  const vaultDir = path.join(root, 'vault');
  const uploadDir = path.join(root, 'staging');
  await fs.mkdir(vaultDir);
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port,
    mcpBaseUrl: `http://127.0.0.1:${port}`,
    denyPaths: ['private'],
    uploadMaxBytes: 65536,
    uploadTempDir: uploadDir,
    vaults: { v: { path: vaultDir } },
    ...extra,
  }));
  const proc = spawn('node', [SERVER_ENTRY], {
    env: { ...process.env, CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    port, root, vaultDir, uploadDir,
    baseUrl: `http://127.0.0.1:${port}`,
    log: () => log,
    async stop() {
      if (proc.exitCode === null) await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function mcpPost(port, body, sid, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...extraHeaders };
    if (sid) headers['mcp-session-id'] = sid;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, agent: false }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const msgs = [];
        for (const line of data.split('\n')) if (line.startsWith('data: ')) { try { msgs.push(JSON.parse(line.slice(6))); } catch {} }
        resolve({ status: res.statusCode, headers: res.headers, msgs });
      });
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

/** Calls a tool on a fresh MCP session; extraHeaders go on every request (for example X-Forwarded-For). */
async function callTool(srv, name, args, extraHeaders = {}) {
  const init = await mcpPost(srv.port, {
    jsonrpc: '2.0', id: '1', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  }, undefined, extraHeaders);
  const sid = init.headers['mcp-session-id'];
  assert.ok(sid, 'initialize should return a session id');
  const r = await mcpPost(srv.port, {
    jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name, arguments: { vault: 'v', ...args } },
  }, sid, extraHeaders);
  assert.equal(r.msgs.length, 1);
  return r.msgs[0].result;
}

/** Reserves an upload and returns the parsed result. */
async function reserve(srv, { filename, folder, content, size, sha, headers } = {}) {
  const result = await callTool(srv, 'upload-binary-file', {
    filename, ...(folder ? { folder } : {}),
    size: size === undefined ? content.length : size, sha256: sha === undefined ? sha256(content) : sha,
  }, headers);
  const text = result.content?.[0]?.text ?? '';
  const url = text.match(/https?:\/\/\S+\/up\/[A-Za-z0-9_-]{43}/)?.[0];
  return { result, text, url, token: url?.split('/up/')[1] };
}

/** One HTTP request, resolving with {status, headers, text, json} or {error}. */
function request(urlStr, { method = 'PUT', body, headers = {}, localAddress, abortAfter } = {}) {
  return new Promise(resolve => {
    const u = new URL(urlStr);
    const h = { ...headers };
    if (body && h['Content-Length'] === undefined && h['Transfer-Encoding'] === undefined && abortAfter === undefined) {
      h['Content-Length'] = body.length;
    }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, agent: false, localAddress }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', err => resolve({ error: err }));
    if (abortAfter !== undefined) {
      req.write(body.subarray(0, abortAfter));
      setTimeout(() => req.destroy(), 100);
      return;
    }
    if (body) req.write(body);
    req.end();
  });
}

/** Speaks HTTP over a raw socket, to see exactly what the server sends (100 Continue and so on). */
function rawExchange(port, head, { body, waitFor100 = false, timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    let received = '';
    let sentBody = false;
    const sendBody = () => { if (body && !sentBody) { sentBody = true; sock.write(body); } };
    sock.on('connect', () => {
      sock.write(head);
      if (!waitFor100) sendBody();
    });
    sock.on('data', chunk => {
      received += chunk.toString('latin1');
      if (waitFor100 && received.includes('100 Continue')) sendBody();
    });
    sock.on('close', () => resolve(received));
    sock.on('error', () => resolve(received));
    setTimeout(() => { sock.destroy(); }, timeoutMs);
  });
}

const stagingFiles = async (srv) => (await fs.readdir(srv.uploadDir)).filter(f => f.startsWith('upload-'));

async function waitForEmptyStaging(srv, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await stagingFiles(srv)).length === 0) return true;
    await sleep(50);
  }
  return false;
}

const exists = (p) => fs.access(p).then(() => true, () => false);

// ── the main server ─────────────────────────────────────────────────────────

describe('upload-binary-file and PUT /up/<token>', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  describe('upload-binary-file (the tool)', () => {
    const content = crypto.randomBytes(500);

    it('returns a URL of the form <base>/up/<random token>, a curl command and the terms', async () => {
      const { result, text, url } = await reserve(srv, { filename: 'tool-1.bin', content });
      assert.ok(!result.isError, text);
      assert.match(url, new RegExp(`^${srv.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/up/[A-Za-z0-9_-]{43}$`));
      assert.ok(text.includes('curl --fail-with-body -sS -T'), text);
      assert.ok(text.includes(`"${url}"`), text);
      assert.ok(text.includes('300 seconds'), text);
      assert.ok(text.includes('one request only'), text);
      assert.ok(text.includes('tool-1.bin'), text);
    });

    it('returns a different URL each time', async () => {
      const a = await reserve(srv, { filename: 'tool-2a.bin', content });
      const b = await reserve(srv, { filename: 'tool-2b.bin', content });
      assert.notEqual(a.token, b.token);
    });

    it('creates nothing in the vault or the staging folder when it only reserves', async () => {
      await reserve(srv, { filename: 'tool-3.bin', folder: 'reserve-only', content });
      assert.equal(await exists(path.join(srv.vaultDir, 'reserve-only')), false);
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('rejects a .md filename', async () => {
      const { result, text } = await reserve(srv, { filename: 'note.md', content });
      assert.ok(result.isError);
      assert.ok(text.includes('.md'), text);
    });

    it('rejects a destination under denyPaths', async () => {
      const { result, text } = await reserve(srv, { filename: 'secret.bin', folder: 'private', content });
      assert.ok(result.isError);
      assert.ok(text.includes('Access denied'), text);
    });

    it('rejects a ..-traversal into a denied path', async () => {
      const { result } = await reserve(srv, { filename: 'secret.bin', folder: 'ok/../private', content });
      assert.ok(result.isError);
    });

    it('rejects a destination that already exists', async () => {
      await fs.writeFile(path.join(srv.vaultDir, 'exists.bin'), 'x');
      const { result, text } = await reserve(srv, { filename: 'exists.bin', content });
      assert.ok(result.isError);
      assert.ok(text.includes('already exists'), text);
    });

    for (const [label, size] of [['zero', 0], ['negative', -5], ['fractional', 1.5], ['a string', '10'], ['null', null], ['over uploadMaxBytes', 65537]]) {
      it(`rejects a size that is ${label}`, async () => {
        const { result } = await reserve(srv, { filename: 'size.bin', content, size });
        assert.ok(result.isError);
      });
    }

    it('accepts a size of exactly uploadMaxBytes', async () => {
      const { result, url } = await reserve(srv, { filename: 'size-max.bin', content, size: 65536 });
      assert.ok(!result.isError);
      assert.ok(url);
    });

    for (const [label, sha] of [['too short', 'abc123'], ['not hexadecimal', 'z'.repeat(64)], ['too long', 'a'.repeat(65)], ['empty', '']]) {
      it(`rejects a hash that is ${label}`, async () => {
        const { result, text } = await reserve(srv, { filename: 'hash.bin', content, sha });
        assert.ok(result.isError);
        assert.ok(text.toLowerCase().includes('sha256'), text);
      });
    }

    it('accepts an upper-case hash', async () => {
      const { result } = await reserve(srv, { filename: 'hash-upper.bin', content, sha: sha256(content).toUpperCase() });
      assert.ok(!result.isError);
    });

    it('requires a filename', async () => {
      const result = await callTool(srv, 'upload-binary-file', { size: 10, sha256: 'a'.repeat(64) });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes('filename is required'));
    });

    it('returns isError for an unknown vault', async () => {
      const result = await callTool(srv, 'upload-binary-file', { vault: 'no-such', filename: 'a.bin', size: 10, sha256: 'a'.repeat(64) });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes('Unknown vault'));
    });

    it('lists upload-binary-file, with a description that explains the curl upload', async () => {
      const init = await mcpPost(srv.port, { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} });
      const r = await mcpPost(srv.port, { jsonrpc: '2.0', id: '2', method: 'tools/list' }, init.headers['mcp-session-id']);
      const tool = r.msgs[0].result.tools.find(t => t.name === 'upload-binary-file');
      assert.ok(tool, 'upload-binary-file should be listed');
      assert.ok(tool.description.includes('curl'));
      assert.ok(tool.description.includes('sha256'));
      assert.ok(/one request/i.test(tool.description));
      assert.deepEqual(tool.inputSchema.required.sort(), ['filename', 'sha256', 'size', 'vault']);
    });
  });

  describe('PUT /up/<token>: a good upload', () => {
    it('lands at the right path with the right bytes and answers 201', async () => {
      const content = crypto.randomBytes(1000);
      const { url } = await reserve(srv, { filename: 'good.bin', folder: 'up-good', content });
      const r = await request(url, { body: content });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(r.json, { path: 'up-good/good.bin', bytes: 1000, sha256: sha256(content) });
      assert.deepEqual(await fs.readFile(path.join(srv.vaultDir, 'up-good/good.bin')), content);
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('creates missing parent folders', async () => {
      const content = crypto.randomBytes(100);
      const { url } = await reserve(srv, { filename: 'deep.bin', folder: 'up-new-a/up-new-b', content });
      const r = await request(url, { body: content });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(await fs.readFile(path.join(srv.vaultDir, 'up-new-a/up-new-b/deep.bin')), content);
    });

    it('accepts a file of exactly the maximum size', async () => {
      const content = crypto.randomBytes(65536);
      const { url } = await reserve(srv, { filename: 'max.bin', content });
      const r = await request(url, { body: content });
      assert.equal(r.status, 201, r.text);
      assert.equal((await fs.stat(path.join(srv.vaultDir, 'max.bin'))).size, 65536);
    });

    it('stores the file under the exact name even if it has spaces or unusual characters', async () => {
      const content = crypto.randomBytes(50);
      const { url } = await reserve(srv, { filename: 'my file (1).bin', folder: 'up odd', content });
      const r = await request(url, { body: content });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(await fs.readFile(path.join(srv.vaultDir, 'up odd/my file (1).bin')), content);
    });

    it('works with a hash given in upper case', async () => {
      const content = crypto.randomBytes(64);
      const { url } = await reserve(srv, { filename: 'upper.bin', content, sha: sha256(content).toUpperCase() });
      const r = await request(url, { body: content });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.sha256, sha256(content));
    });

    it('the same URL cannot be used twice', async () => {
      const content = crypto.randomBytes(100);
      const { url } = await reserve(srv, { filename: 'once.bin', content });
      assert.equal((await request(url, { body: content })).status, 201);
      const again = await request(url, { body: content });
      assert.equal(again.status, 404);
      assert.equal((await fs.readFile(path.join(srv.vaultDir, 'once.bin'))).length, 100);
    });
  });

  describe('PUT /up/<token>: checks on what is received', () => {
    it('a wrong hash answers 422, and leaves nothing in the vault or the staging folder', async () => {
      const declared = crypto.randomBytes(200);
      const sent = crypto.randomBytes(200);
      const { url } = await reserve(srv, { filename: 'badhash.bin', content: declared });
      const r = await request(url, { body: sent });
      assert.equal(r.status, 422, r.text);
      assert.equal(r.json.expected, sha256(declared));
      assert.equal(r.json.actual, sha256(sent));
      assert.equal(await exists(path.join(srv.vaultDir, 'badhash.bin')), false);
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('a body shorter than the declared size is refused with 400', async () => {
      const content = crypto.randomBytes(300);
      const { url } = await reserve(srv, { filename: 'short.bin', content });
      const r = await request(url, { body: content.subarray(0, 299) });
      assert.equal(r.status, 400, r.text);
      assert.equal(await exists(path.join(srv.vaultDir, 'short.bin')), false);
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('a body longer than the declared size is refused with 413', async () => {
      const content = crypto.randomBytes(300);
      const { url } = await reserve(srv, { filename: 'long.bin', content });
      const r = await request(url, { body: Buffer.concat([content, Buffer.from('x')]) });
      assert.equal(r.status, 413, r.text);
      assert.equal(await exists(path.join(srv.vaultDir, 'long.bin')), false);
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('a body without Content-Length (chunked) is refused with 411', async () => {
      const content = crypto.randomBytes(300);
      const { url } = await reserve(srv, { filename: 'chunked.bin', content });
      const r = await request(url, { body: content, headers: { 'Transfer-Encoding': 'chunked' } });
      assert.equal(r.status, 411, r.text);
      assert.equal(await exists(path.join(srv.vaultDir, 'chunked.bin')), false);
    });

    it('a connection that closes early leaves no file and no staging file, and the URL is dead', async () => {
      const content = crypto.randomBytes(5000);
      const { url } = await reserve(srv, { filename: 'abort.bin', content });
      const r = await request(url, { body: content, headers: { 'Content-Length': 5000 }, abortAfter: 2000 });
      assert.ok(r.error, 'the client should have been cut off');
      assert.ok(await waitForEmptyStaging(srv), 'staging file should be removed');
      assert.equal(await exists(path.join(srv.vaultDir, 'abort.bin')), false);
      assert.equal((await request(url, { body: content })).status, 404);
    });

    it('answers 409 if the destination appeared after the URL was reserved, leaving it untouched', async () => {
      const content = crypto.randomBytes(100);
      const { url } = await reserve(srv, { filename: 'raced.bin', content });
      await fs.writeFile(path.join(srv.vaultDir, 'raced.bin'), 'someone else got there first');
      const r = await request(url, { body: content });
      assert.equal(r.status, 409, r.text);
      assert.equal(await fs.readFile(path.join(srv.vaultDir, 'raced.bin'), 'utf8'), 'someone else got there first');
      assert.deepEqual(await stagingFiles(srv), []);
    });
  });

  describe('PUT /up/<token>: the first request of any kind uses the URL up', () => {
    const content = crypto.randomBytes(100);

    it('a GET answers 405 with Allow: PUT, and the URL is then dead', async () => {
      const { url } = await reserve(srv, { filename: 'kill-get.bin', content });
      const g = await request(url, { method: 'GET' });
      assert.equal(g.status, 405);
      assert.equal(g.headers.allow, 'PUT');
      assert.equal((await request(url, { body: content })).status, 404);
      assert.equal(await exists(path.join(srv.vaultDir, 'kill-get.bin')), false);
    });

    for (const method of ['POST', 'DELETE', 'HEAD']) {
      it(`a ${method} answers 405 and the URL is then dead`, async () => {
        const { url } = await reserve(srv, { filename: `kill-${method}.bin`, content });
        assert.equal((await request(url, { method })).status, 405);
        assert.equal((await request(url, { body: content })).status, 404);
      });
    }

    for (const origin of ['http://example.com', 'http://localhost', 'null']) {
      it(`a request with Origin: ${origin} is refused with 403, and the URL is then dead`, async () => {
        const { url } = await reserve(srv, { filename: `kill-origin-${origin.replace(/\W/g, '')}.bin`, content });
        const r = await request(url, { body: content, headers: { Origin: origin } });
        assert.equal(r.status, 403, r.text);
        assert.equal((await request(url, { body: content })).status, 404);
      });
    }

    it('a request from a different address answers 403, and the URL is then dead', async t => {
      const { url } = await reserve(srv, { filename: 'kill-addr.bin', content });
      const r = await request(url, { body: content, localAddress: '127.0.0.2' });
      if (r.error?.code === 'EADDRNOTAVAIL') return t.skip('127.0.0.2 is not available on this machine');
      assert.equal(r.status, 403, r.text);
      assert.equal((await request(url, { body: content })).status, 404);
      assert.equal(await exists(path.join(srv.vaultDir, 'kill-addr.bin')), false);
    });

    it('a request with a bad Content-Length kills the URL too', async () => {
      const { url } = await reserve(srv, { filename: 'kill-len.bin', content });
      assert.equal((await request(url, { body: content.subarray(0, 50) })).status, 400);
      assert.equal((await request(url, { body: content })).status, 404);
    });

    it('a request naming an unknown token answers 404 and kills nothing else', async () => {
      const { url } = await reserve(srv, { filename: 'unrelated.bin', content });
      const fake = `${srv.baseUrl}/up/${'A'.repeat(43)}`;
      assert.equal((await request(fake, { body: content })).status, 404);
      assert.equal((await request(url, { body: content })).status, 201);
    });

    for (const bad of ['/up/', '/up/short', `/up/${'A'.repeat(42)}`, `/up/${'A'.repeat(44)}`, `/up/${'A'.repeat(42)}!`, `/up/${'A'.repeat(43)}/extra`]) {
      it(`answers 404 for the malformed path ${bad}`, async () => {
        assert.equal((await request(`${srv.baseUrl}${bad}`, { body: content })).status, 404);
      });
    }

    it('an unknown, used and expired token all get the same 404 body, so nothing is revealed', async () => {
      const { url } = await reserve(srv, { filename: 'same404.bin', content });
      await request(url, { body: content });
      const used = await request(url, { body: content });
      const unknown = await request(`${srv.baseUrl}/up/${'B'.repeat(43)}`, { body: content });
      assert.equal(used.status, 404);
      assert.equal(used.text, unknown.text);
    });
  });

  describe('PUT /up/<token>: Expect: 100-continue', () => {
    it('answers 100 Continue only after the checks pass, then 201', async () => {
      const content = crypto.randomBytes(2000);
      const { token } = await reserve(srv, { filename: 'expect-ok.bin', content });
      const head = `PUT /up/${token} HTTP/1.1\r\nHost: x\r\nContent-Length: 2000\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`;
      const out = await rawExchange(srv.port, head, { body: content, waitFor100: true });
      assert.ok(out.startsWith('HTTP/1.1 100 Continue'), out.slice(0, 80));
      assert.ok(out.includes('HTTP/1.1 201'), out);
      assert.deepEqual(await fs.readFile(path.join(srv.vaultDir, 'expect-ok.bin')), content);
    });

    it('refuses without ever sending 100 Continue when a check fails', async () => {
      const content = crypto.randomBytes(2000);
      const { token } = await reserve(srv, { filename: 'expect-bad.bin', content });
      const head = `PUT /up/${token} HTTP/1.1\r\nHost: x\r\nContent-Length: 1999\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`;
      const out = await rawExchange(srv.port, head, { body: content, waitFor100: true, timeoutMs: 1500 });
      assert.ok(!out.includes('100 Continue'), out);
      assert.ok(out.includes('HTTP/1.1 400'), out);
    });

    it('still answers 100 Continue for an ordinary request that expects it', async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const head = `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`;
      const out = await rawExchange(srv.port, head, { body, waitFor100: true });
      assert.ok(out.startsWith('HTTP/1.1 100 Continue'), out.slice(0, 80));
      assert.ok(out.includes('HTTP/1.1 200'), out);
    });
  });

  describe('PUT /up/<token>: too many uploads at once', () => {
    it('answers 503 for a fifth simultaneous upload, and cleans up when the others are cut off', async () => {
      const stalled = [];
      for (let i = 0; i < 4; i++) {
        const content = crypto.randomBytes(1000);
        const { token } = await reserve(srv, { filename: `stall-${i}.bin`, content });
        const sock = net.connect(srv.port, '127.0.0.1');
        await new Promise(r => sock.on('connect', r));
        sock.write(`PUT /up/${token} HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n`);
        sock.write(content.subarray(0, 10));
        sock.on('error', () => {});
        stalled.push(sock);
      }
      await sleep(300);
      const content = crypto.randomBytes(100);
      const { url } = await reserve(srv, { filename: 'fifth.bin', content });
      const r = await request(url, { body: content });
      assert.equal(r.status, 503, r.text);
      for (const s of stalled) s.destroy();
      assert.ok(await waitForEmptyStaging(srv), 'staging files should be removed after the clients disconnect');
      for (let i = 0; i < 4; i++) assert.equal(await exists(path.join(srv.vaultDir, `stall-${i}.bin`)), false);
    });
  });

  describe('the server log', () => {
    it('never contains a token or an upload URL, and shows the path redacted', async () => {
      const content = crypto.randomBytes(100);
      const { token, url } = await reserve(srv, { filename: 'logged.bin', content });
      await request(url, { body: content });
      await request(url, { body: content }); // a second, rejected request
      await sleep(200);
      const log = srv.log();
      assert.ok(!log.includes(token), 'the token must not be logged');
      assert.ok(!log.includes(url), 'the URL must not be logged');
      assert.ok(log.includes('/up/<redacted>'), 'the redacted path should be logged');
    });
  });

  describe('callers behind a proxy that is not trusted (trustedProxies empty)', () => {
    it('ignores X-Forwarded-For, so a forged header changes nothing', async () => {
      const content = crypto.randomBytes(100);
      const { url } = await reserve(srv, { filename: 'xff-ignored.bin', content, headers: { 'X-Forwarded-For': '203.0.113.9' } });
      const r = await request(url, { body: content, headers: { 'X-Forwarded-For': '198.51.100.7' } });
      assert.equal(r.status, 201, r.text);
    });

    it('logs a hint that trustedProxies may need setting', async () => {
      const content = crypto.randomBytes(100);
      const { url } = await reserve(srv, { filename: 'xff-hint.bin', content, headers: { 'X-Forwarded-For': '203.0.113.9' } });
      await request(url, { body: content });
      await sleep(200);
      assert.ok(srv.log().includes('trustedProxies'), 'a hint about trustedProxies should be logged');
    });
  });
});

// ── trusted proxies ─────────────────────────────────────────────────────────

describe('upload addresses behind a trusted proxy', () => {
  let srv;
  before(async () => { srv = await startServer({ trustedProxies: ['127.0.0.1', '::1'] }); });
  after(async () => { await srv.stop(); });
  const content = crypto.randomBytes(100);

  it('accepts an upload from the same forwarded address that reserved it', async () => {
    const { url } = await reserve(srv, { filename: 'same.bin', content, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    const r = await request(url, { body: content, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(r.status, 201, r.text);
  });

  it('refuses an upload from a different forwarded address with 403, and the URL is then dead', async () => {
    const { url } = await reserve(srv, { filename: 'other.bin', content, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    const r = await request(url, { body: content, headers: { 'X-Forwarded-For': '198.51.100.7' } });
    assert.equal(r.status, 403, r.text);
    assert.equal((await request(url, { body: content, headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 404);
    assert.equal(await exists(path.join(srv.vaultDir, 'other.bin')), false);
  });

  it('treats a request with no header as the proxy itself, which is a different caller', async () => {
    const { url } = await reserve(srv, { filename: 'noheader.bin', content, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    const r = await request(url, { body: content });
    assert.equal(r.status, 403, r.text);
  });

  it('is not fooled by a forged leftmost entry: the rightmost untrusted entry is the caller', async () => {
    const { url } = await reserve(srv, { filename: 'chain.bin', content, headers: { 'X-Forwarded-For': '1.1.1.1, 203.0.113.9' } });
    const r = await request(url, { body: content, headers: { 'X-Forwarded-For': '2.2.2.2, 203.0.113.9' } });
    assert.equal(r.status, 201, r.text);
  });

  it('does not log the proxy hint when the proxy is trusted', async () => {
    await sleep(100);
    assert.ok(!srv.log().includes('trustedProxies'), srv.log());
  });
});

// ── limits and URL building ─────────────────────────────────────────────────

describe('upload limits', () => {
  let srv;
  before(async () => {
    const port = nextPort; // startServer takes this port next
    srv = await startServer({ mcpBaseUrl: `http://127.0.0.1:${port}/` });
  });
  after(async () => { await srv.stop(); });

  it('builds the URL without a doubled slash when mcpBaseUrl ends in one', async () => {
    const content = crypto.randomBytes(10);
    const { url } = await reserve(srv, { filename: 'slash.bin', content });
    assert.ok(url, 'a URL should be returned');
    assert.ok(!url.includes('//up/'), url);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/up\/[A-Za-z0-9_-]{43}$/);
  });

});

describe('upload reservation cap', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it('allows 16 outstanding reservations and refuses the 17th', async () => {
    const content = crypto.randomBytes(10);
    for (let i = 0; i < 16; i++) {
      const { result, text } = await reserve(srv, { filename: `cap-${i}.bin`, content });
      assert.ok(!result.isError, `${i}: ${text}`);
    }
    const { result, text } = await reserve(srv, { filename: 'cap-extra.bin', content });
    assert.ok(result.isError);
    assert.ok(/too many|pending/i.test(text), text);
  });
});

describe('upload reservation cap frees up as uploads are used', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it('a reservation that is used makes room for another', async () => {
    const content = crypto.randomBytes(10);
    const urls = [];
    for (let i = 0; i < 16; i++) urls.push((await reserve(srv, { filename: `free-${i}.bin`, content })).url);
    assert.ok((await reserve(srv, { filename: 'free-extra.bin', content })).result.isError);
    assert.equal((await request(urls[0], { body: content })).status, 201);
    const again = await reserve(srv, { filename: 'free-after.bin', content });
    assert.ok(!again.result.isError, again.text);
  });
});

describe('upload expiry', () => {
  let srv;
  before(async () => { srv = await startServer({ uploadTtlSeconds: 1 }); });
  after(async () => { await srv.stop(); });

  it('a URL stops working once its lifetime has passed, with the same 404 as any other dead URL', async () => {
    const content = crypto.randomBytes(100);
    const { url, text } = await reserve(srv, { filename: 'expired.bin', content });
    assert.ok(text.includes('1 seconds') || text.includes('1 second'), text);
    await sleep(1300);
    assert.equal((await request(url, { body: content })).status, 404);
    assert.equal(await exists(path.join(srv.vaultDir, 'expired.bin')), false);
  });

  it('a URL used within its lifetime works', async () => {
    const content = crypto.randomBytes(100);
    const { url } = await reserve(srv, { filename: 'in-time.bin', content });
    assert.equal((await request(url, { body: content })).status, 201);
  });
});

// ── configuration and the staging folder ────────────────────────────────────

/**
 * Starts a server with the given config extras and resolves once it is listening or has exited.
 * @param {(ctx: {root: string, vaultDir: string}) => Promise<object>|object} makeExtra
 * @returns {Promise<{code: number|null, out: string, root: string, vaultDir: string, stop: () => Promise<void>}>}
 */
async function tryStart(makeExtra, { env = {} } = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-cfg-'));
  const vaultDir = path.join(root, 'vault');
  await fs.mkdir(vaultDir);
  const extra = typeof makeExtra === 'function' ? await makeExtra({ root, vaultDir }) : makeExtra;
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port, mcpBaseUrl: `http://127.0.0.1:${port}`, vaults: { v: { path: vaultDir } }, ...extra,
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await new Promise(resolve => {
    let out = '';
    const timer = setTimeout(() => { proc.kill(); resolve({ code: 'timeout', out }); }, 15_000);
    const onData = chunk => { out += chunk.toString(); if (out.includes('listening')) { clearTimeout(timer); resolve({ code: null, out }); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
  return {
    ...result, root, vaultDir, port, uploadDir: extra.uploadTempDir, baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) await new Promise(r => { proc.once('exit', r); proc.kill(); });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe('upload settings', () => {
  const rejects = (label, extra, message) => it(`rejects ${label}`, async () => {
    const r = await tryStart(extra);
    try {
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes(message), r.out);
    } finally { await r.stop(); }
  });

  for (const bad of [0, -1, 'abc']) {
    rejects(`uploadMaxBytes ${JSON.stringify(bad)}`, { uploadMaxBytes: bad }, '"uploadMaxBytes" must be a positive number');
    rejects(`uploadTtlSeconds ${JSON.stringify(bad)}`, { uploadTtlSeconds: bad }, '"uploadTtlSeconds" must be a positive number');
  }

  for (const bad of [123, '', '   ', ['/tmp/x'], {}]) {
    rejects(`uploadTempDir ${JSON.stringify(bad)}`, { uploadTempDir: bad }, '"uploadTempDir" must be a non-empty string');
  }
  rejects('a relative uploadTempDir', { uploadTempDir: 'staging' }, '"uploadTempDir" must be an absolute path');
  rejects('an uploadTempDir inside a vault', ({ vaultDir }) => ({ uploadTempDir: path.join(vaultDir, '.staging') }), '"uploadTempDir" must not be inside a vault');
  rejects('an uploadTempDir that contains a vault', ({ root }) => ({ uploadTempDir: root }), '"uploadTempDir" must not contain a vault');

  for (const bad of ['10.0.0.0/8', [1], [['a']], {}, null]) {
    rejects(`trustedProxies ${JSON.stringify(bad)}`, { trustedProxies: bad }, '"trustedProxies" must be an array of strings');
  }
  rejects('a trustedProxies entry that is not an address', { trustedProxies: ['nonsense'] }, 'Invalid trusted proxy "nonsense"');
  rejects('a trustedProxies range that is too wide', { trustedProxies: ['10.0.0.0/33'] }, 'Invalid trusted proxy "10.0.0.0/33"');

  it('rejects, at startup, an uploadTempDir that is a symbolic link into a vault', async () => {
    const r = await tryStart(async ({ root, vaultDir }) => {
      await fs.mkdir(path.join(vaultDir, 'inner'));
      await fs.symlink(path.join(vaultDir, 'inner'), path.join(root, 'link'));
      return { uploadTempDir: path.join(root, 'link') };
    });
    try {
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes('Cannot use "uploadTempDir"'), r.out);
    } finally { await r.stop(); }
  });

  it('starts with valid settings and creates the staging folder with mode 0700', async () => {
    const r = await tryStart(({ root }) => ({
      uploadMaxBytes: 1024, uploadTtlSeconds: 60, trustedProxies: ['127.0.0.1', '10.0.0.0/8', '::1'],
      uploadTempDir: path.join(root, 'made', 'here'),
    }));
    try {
      assert.equal(r.code, null, r.out);
      const st = await fs.stat(path.join(r.root, 'made', 'here'));
      assert.ok(st.isDirectory());
      assert.equal(st.mode & 0o777, 0o700);
    } finally { await r.stop(); }
  });

  it('removes stale staging files at startup, and nothing else in the folder', async () => {
    const r = await tryStart(async ({ root }) => {
      const dir = path.join(root, 'staging');
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'upload-0123abcd.part'), 'stale');
      await fs.writeFile(path.join(dir, 'keep-me.txt'), 'keep');
      return { uploadTempDir: dir };
    });
    try {
      assert.equal(r.code, null, r.out);
      assert.deepEqual(await fs.readdir(path.join(r.root, 'staging')), ['keep-me.txt']);
      assert.ok(r.out.includes('removed 1 stale upload file'), r.out);
    } finally { await r.stop(); }
  });

  it('uses a per-user obsidian-mcp-uploads folder under the temporary directory when uploadTempDir is not set', async () => {
    const r = await tryStart({});
    try {
      assert.equal(r.code, null, r.out);
      const st = await fs.stat(defaultUploadTempDir());
      assert.ok(st.isDirectory());
      assert.equal(st.mode & 0o077, 0, 'group and others must have no access');
    } finally { await r.stop(); }
  });

  it('still serves the other tools when the default staging folder cannot be created, and says why on upload-binary-file', async () => {
    // A read-only container has no writable temporary directory; uploads are an optional
    // feature, so the server must start and only that tool must refuse.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-ro-'));
    try {
      const blocker = path.join(root, 'not-a-folder');
      await fs.writeFile(blocker, 'x');
      const r = await tryStart({}, { env: { TMPDIR: path.join(blocker, 'tmp') } });
      try {
        assert.equal(r.code, null, r.out);
        assert.ok(/uploads are disabled/i.test(r.out), r.out);
        assert.ok(r.out.includes('"uploadTempDir"'), r.out);

        const init = await mcpPost(r.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        const sid = init.headers['mcp-session-id'];
        const up = await mcpPost(r.port, {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'upload-binary-file', arguments: { vault: 'v', filename: 'a.bin', size: 10, sha256: 'a'.repeat(64) } },
        }, sid);
        const result = up.msgs[0].result;
        assert.ok(result.isError);
        assert.ok(result.content[0].text.includes('"uploadTempDir"'), result.content[0].text);

        const list = await mcpPost(r.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list-vaults', arguments: {} } }, sid);
        assert.ok(!list.msgs[0].result.isError, JSON.stringify(list.msgs[0].result));
      } finally { await r.stop(); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('refuses to start if the default staging folder is a symbolic link', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-tmpdir-'));
    try {
      const tmp = path.join(root, 'tmp');
      const elsewhere = path.join(root, 'elsewhere');
      await fs.mkdir(tmp);
      await fs.mkdir(elsewhere);
      const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
      await fs.symlink(elsewhere, path.join(tmp, `obsidian-mcp-uploads${uid}`));
      const r = await tryStart({}, { env: { TMPDIR: tmp } });
      try {
        assert.equal(r.code, 1, r.out);
        assert.ok(r.out.includes('symbolic link'), r.out);
        assert.ok(r.out.includes('"uploadTempDir"'), r.out);
      } finally { await r.stop(); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('keeps staging in the folder it checked, even if a configured link is re-pointed afterwards', async () => {
    let real; let attacker; let link;
    const r = await tryStart(async ({ root }) => {
      real = path.join(root, 'real-staging');
      attacker = path.join(root, 'attacker-dir');
      link = path.join(root, 'staging-link');
      await fs.mkdir(real, { mode: 0o700 });
      await fs.mkdir(attacker);
      await fs.symlink(real, link);
      return { uploadTempDir: link };
    });
    try {
      assert.equal(r.code, null, r.out);
      await fs.rm(link);
      await fs.symlink(attacker, link); // someone re-points the link after the check

      const content = crypto.randomBytes(1000);
      const { token } = await reserve(r, { filename: 'repoint.bin', content });
      const sock = net.connect(r.port, '127.0.0.1');
      await new Promise(res => sock.on('connect', res));
      sock.on('error', () => {});
      sock.write(`PUT /up/${token} HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n`);
      sock.write(content.subarray(0, 10)); // a half-finished upload, so its staging file exists right now
      await sleep(300);
      const staged = (await fs.readdir(real)).filter(f => f.startsWith('upload-'));
      assert.equal(staged.length, 1, 'the staging file should be in the folder that was checked');
      assert.deepEqual(await fs.readdir(attacker), [], 'nothing may be staged in the re-pointed folder');
      sock.destroy();
    } finally { await r.stop(); }
  });

  it('tightens the permissions of an existing staging folder that is open to others', async () => {
    const r = await tryStart(async ({ root }) => {
      const dir = path.join(root, 'open-staging');
      await fs.mkdir(dir);
      await fs.chmod(dir, 0o777);
      return { uploadTempDir: dir };
    });
    try {
      assert.equal(r.code, null, r.out);
      assert.equal((await fs.stat(path.join(r.root, 'open-staging'))).mode & 0o777, 0o700);
      assert.ok(r.out.includes('restricted the permissions'), r.out);
    } finally { await r.stop(); }
  });

  it('refuses to start with a staging folder owned by another user', async t => {
    if (process.getuid?.() === 0) return t.skip('running as root, which owns /usr');
    const r = await tryStart({ uploadTempDir: '/usr' });
    try {
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes('owned by another user'), r.out);
      assert.ok(r.out.includes('"uploadTempDir"'), r.out);
    } finally { await r.stop(); }
  });
});

// ── failures while receiving, and what ends up in the vault ─────────────────

describe('upload failures and placement', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it('answers 500, and logs the cause, when the file cannot be written (staging folder gone)', async () => {
    const content = crypto.randomBytes(2000);
    const { url } = await reserve(srv, { filename: 'nostage.bin', content });
    await fs.rm(srv.uploadDir, { recursive: true });
    try {
      const r = await request(url, { body: content });
      assert.equal(r.status, 500, JSON.stringify(r));
      assert.equal(r.json.error, 'upload failed');
      await sleep(200);
      assert.ok(srv.log().includes('upload failed'), 'the cause should be logged');
      assert.equal(await exists(path.join(srv.vaultDir, 'nostage.bin')), false);
    } finally {
      await fs.mkdir(srv.uploadDir, { recursive: true, mode: 0o700 });
    }
  });

  it('the server keeps working after such a failure', async () => {
    const content = crypto.randomBytes(300);
    const { url } = await reserve(srv, { filename: 'after-failure.bin', content });
    assert.equal((await request(url, { body: content })).status, 201);
  });

  describe('symbolic links inside the vault', () => {
    let outside;
    before(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-outside-'));
      await fs.mkdir(path.join(srv.vaultDir, 'private'), { recursive: true });
    });
    after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
    const content = crypto.randomBytes(100);

    it('refuses to reserve an upload into a folder that is a link out of the vault', async () => {
      await fs.symlink(outside, path.join(srv.vaultDir, 'link-out'));
      const { result, text } = await reserve(srv, { filename: 'esc.bin', folder: 'link-out', content });
      assert.ok(result.isError);
      assert.ok(text.includes('Access denied'), text);
    });

    it('refuses to reserve an upload through a link to a denied folder inside the vault', async () => {
      await fs.symlink(path.join(srv.vaultDir, 'private'), path.join(srv.vaultDir, 'link-private'));
      const { result } = await reserve(srv, { filename: 'sneaky.bin', folder: 'link-private', content });
      assert.ok(result.isError);
    });

    it('refuses at placement if a link out of the vault appeared after the reservation', async () => {
      const { url } = await reserve(srv, { filename: 'swap.bin', folder: 'swapped', content });
      await fs.symlink(outside, path.join(srv.vaultDir, 'swapped'));
      const r = await request(url, { body: content });
      assert.equal(r.status, 403, r.text);
      assert.deepEqual(await fs.readdir(outside), [], 'nothing may be written outside the vault');
      assert.deepEqual(await stagingFiles(srv), []);
    });

    it('refuses at placement if a link to a denied folder appeared after the reservation', async () => {
      const { url } = await reserve(srv, { filename: 'late.bin', folder: 'late-swap', content });
      await fs.symlink(path.join(srv.vaultDir, 'private'), path.join(srv.vaultDir, 'late-swap'));
      const r = await request(url, { body: content });
      assert.equal(r.status, 403, r.text);
      assert.equal(await exists(path.join(srv.vaultDir, 'private', 'late.bin')), false);
    });

    it('still places a file through a link that stays inside the vault and is allowed', async () => {
      await fs.mkdir(path.join(srv.vaultDir, 'real-dir'));
      await fs.symlink(path.join(srv.vaultDir, 'real-dir'), path.join(srv.vaultDir, 'link-in'));
      const { url } = await reserve(srv, { filename: 'inside.bin', folder: 'link-in', content });
      assert.equal((await request(url, { body: content })).status, 201);
      assert.deepEqual(await fs.readFile(path.join(srv.vaultDir, 'real-dir', 'inside.bin')), content);
    });
  });

  describe('the placed file', () => {
    it('gets the permissions any other file in that folder would get, not the private staging ones', async () => {
      const content = crypto.randomBytes(500);
      const { url } = await reserve(srv, { filename: 'mode.bin', folder: 'mode-dir', content });
      assert.equal((await request(url, { body: content })).status, 201);
      await fs.writeFile(path.join(srv.vaultDir, 'mode-dir', 'reference.bin'), 'x');
      const placed = (await fs.stat(path.join(srv.vaultDir, 'mode-dir', 'mode.bin'))).mode & 0o777;
      const reference = (await fs.stat(path.join(srv.vaultDir, 'mode-dir', 'reference.bin'))).mode & 0o777;
      assert.equal(placed, reference);
    });

    it('is a file of its own, not linked to anything left in the staging folder', async () => {
      const content = crypto.randomBytes(500);
      const { url } = await reserve(srv, { filename: 'own.bin', content });
      assert.equal((await request(url, { body: content })).status, 201);
      assert.equal((await fs.stat(path.join(srv.vaultDir, 'own.bin'))).nlink, 1);
    });

    it('leaves no temporary file beside it', async () => {
      const content = crypto.randomBytes(500);
      const { url } = await reserve(srv, { filename: 'tidy.bin', folder: 'tidy-dir', content });
      assert.equal((await request(url, { body: content })).status, 201);
      assert.deepEqual(await fs.readdir(path.join(srv.vaultDir, 'tidy-dir')), ['tidy.bin']);
    });

    it('never shows a partly written file at its final name', async () => {
      const content = crypto.randomBytes(40000);
      const { url } = await reserve(srv, { filename: 'whole.bin', folder: 'whole-dir', content });
      const seen = [];
      let stop = false;
      const watcher = (async () => {
        while (!stop) {
          try { seen.push((await fs.stat(path.join(srv.vaultDir, 'whole-dir', 'whole.bin'))).size); } catch {}
          await sleep(1);
        }
      })();
      assert.equal((await request(url, { body: content })).status, 201);
      stop = true;
      await watcher;
      assert.ok(seen.every(size => size === 40000), `sizes seen at the final name: ${[...new Set(seen)]}`);
    });
  });

  describe('the request itself', () => {
    it('answers 100 Continue for an Expect header that lists it with other values', async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const head = `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nExpect: 100-continue, x-other\r\nConnection: close\r\n\r\n`;
      const out = await rawExchange(srv.port, head, { body, waitFor100: true });
      assert.ok(out.startsWith('HTTP/1.1 100 Continue'), out.slice(0, 80));
      assert.ok(out.includes('HTTP/1.1 200'), out);
    });

    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      it(`treats a vault named ${name} as unknown`, async () => {
        const result = await callTool(srv, 'upload-binary-file', { vault: name, filename: 'a.bin', size: 10, sha256: 'a'.repeat(64) });
        assert.ok(result.isError);
        assert.ok(result.content[0].text.includes('Unknown vault'), result.content[0].text);
      });
    }
  });
});

describe('upload addresses when the proxy header is malformed', () => {
  let srv;
  before(async () => { srv = await startServer({ trustedProxies: ['127.0.0.1', '::1'] }); });
  after(async () => { await srv.stop(); });
  const content = crypto.randomBytes(50);

  for (const header of ['garbage', '203.0.113.9:4711', 'evil, 203.0.113.9', '203.0.113.9, ']) {
    it(`refuses to reserve an upload when X-Forwarded-For is ${JSON.stringify(header)}`, async () => {
      const { result, text } = await reserve(srv, { filename: 'bad-xff.bin', content, headers: { 'X-Forwarded-For': header } });
      assert.ok(result.isError);
      assert.ok(text.includes('Could not work out the address'), text);
    });
  }

  it('compares IPv6 callers by their canonical spelling', async () => {
    const { url } = await reserve(srv, { filename: 'v6.bin', content, headers: { 'X-Forwarded-For': '2001:db8:0:0::1' } });
    const r = await request(url, { body: content, headers: { 'X-Forwarded-For': '2001:0db8::0001' } });
    assert.equal(r.status, 201, r.text);
  });
});
