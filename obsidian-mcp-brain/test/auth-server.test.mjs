/**
 * Integration tests for resource server mode: spawns real servers with an `auth` object
 * pointing at a local issuer (test/helpers/issuer.mjs) and makes real HTTP requests.
 * Ports 20100 and up.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIssuer } from './helpers/issuer.mjs';
import { TOOL_ROLES } from '../lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');
let nextPort = 20100;

const OWNER = 'owner@example.test';
const VIEWER = 'viewer@example.test';
const STRANGER = 'stranger@example.test';

// ── harness ─────────────────────────────────────────────────────────────────

/** Writes a config and spawns a server; resolves once it is listening, or with its exit. */
async function launch(configFor, { expectExit = false } = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-test-'));
  const vaultDir = path.join(root, 'vault');
  await fs.mkdir(vaultDir);
  await fs.writeFile(path.join(vaultDir, 'hello.md'), '# Hello\n');
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port,
    mcpBaseUrl: `http://127.0.0.1:${port}`,
    uploadTempDir: path.join(root, 'staging'),
    vaults: { v: { path: vaultDir } },
    ...configFor({ port, root, vaultDir }),
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const collect = (c) => { log += c.toString(); };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in time\n${log}`)), 15_000);
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ exited: true, code }); });
    const poll = setInterval(() => {
      if (log.includes('listening')) { clearInterval(poll); clearTimeout(timer); resolve({ exited: false }); }
    }, 25);
    proc.on('exit', () => clearInterval(poll));
  });
  const srv = {
    port, root, vaultDir,
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    exited: outcome.exited,
    code: outcome.code,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) await new Promise(r => { proc.once('exit', r); proc.kill(); });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  if (!expectExit && srv.exited) throw new Error(`server exited early with code ${srv.code}\n${log}`);
  return srv;
}

const authFor = (iss, extra = {}) => () => ({
  auth: {
    issuer: iss.issuer, jwksUri: iss.jwksUri, audience: iss.audience,
    userClaim: 'email', users: [OWNER], readOnlyUsers: [VIEWER],
    tokenHeader: 'x-forwarded-token', ...extra,
  },
});

/** One HTTP request. */
function request(srv, { method = 'POST', path: p = '/mcp', headers = {}, body, token, sid } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (sid) h['mcp-session-id'] = sid;
    let data;
    if (body !== undefined) {
      data = typeof body === 'string' ? body : JSON.stringify(body);
      h['content-type'] = h['content-type'] ?? 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ hostname: '127.0.0.1', port: srv.port, path: p, method, headers: h, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      // A GET stream never ends: answer as soon as the headers are in.
      if (method === 'GET' && (p === '/mcp' || p === '/brain') && res.statusCode === 200) {
        res.destroy();
        return resolve({ status: res.statusCode, headers: res.headers, text: '', msgs: [] });
      }
      res.on('data', c => { text += c; });
      res.on('end', () => {
        const msgs = [];
        for (const line of text.split('\n')) if (line.startsWith('data: ')) { try { msgs.push(JSON.parse(line.slice(6))); } catch { /* not a JSON event */ } }
        let json; try { json = JSON.parse(text); } catch { /* the body is not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, msgs });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Waits until `check()` is true, or fails. */
async function until(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('timed out waiting for the condition');
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const INIT = rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

/** Initializes a session with a token and returns its id. */
async function session(srv, token) {
  const r = await request(srv, { body: INIT, token });
  assert.equal(r.status, 200, r.text);
  return r.headers['mcp-session-id'];
}

async function call(srv, token, sid, name, args = {}) {
  const r = await request(srv, { body: rpc(7, 'tools/call', { name, arguments: { vault: 'v', ...args } }), token, sid });
  assert.equal(r.status, 200, r.text);
  return r.msgs[0].result;
}

async function toolNames(srv, token, sid) {
  const r = await request(srv, { body: rpc(3, 'tools/list'), token, sid });
  assert.equal(r.status, 200, r.text);
  return r.msgs[0].result.tools.map(t => t.name);
}

// ── resource server mode ────────────────────────────────────────────────────

describe('resource server mode', () => {
  let iss;
  let srv;
  const tok = (email = OWNER, over = {}, opts) => iss.sign(iss.claims({ email, ...over }), opts);

  before(async () => {
    iss = await createIssuer();
    srv = await launch(authFor(iss));
  });
  after(async () => { await srv.stop(); await iss.stop(); });

  describe('requests to /mcp', () => {
    it('refuses a request with no token: 401, pointing at the resource metadata, and nothing runs', async () => {
      const r = await request(srv, { body: INIT });
      assert.equal(r.status, 401);
      const header = r.headers['www-authenticate'];
      assert.equal(header, `Bearer resource_metadata="${srv.base}/.well-known/oauth-protected-resource"`);
      assert.equal(r.headers['mcp-session-id'], undefined, 'no session may be created');
      assert.equal(r.json.error, 'unauthorized');
    });

    it('refuses a token that is not valid: 401 with invalid_token', async () => {
      const r = await request(srv, { body: INIT, token: tok(OWNER, { exp: 1 }) });
      assert.equal(r.status, 401);
      assert.match(r.headers['www-authenticate'], /error="invalid_token", error_description="expired"/);
      assert.match(r.headers['www-authenticate'], /resource_metadata="/);
    });

    it('refuses a token with a signature that was not made by the issuer', async () => {
      const forged = tok(OWNER).split('.').slice(0, 2).join('.') + '.' + Buffer.alloc(256, 1).toString('base64url');
      assert.equal((await request(srv, { body: INIT, token: forged })).status, 401);
    });

    it('refuses a token that names a key the issuer does not have', async () => {
      const r = await request(srv, { body: INIT, token: tok(OWNER, {}, { header: { kid: 'no-such-key' } }) });
      assert.equal(r.status, 401);
      assert.match(r.headers['www-authenticate'], /error_description="unknown key"/);
    });

    it('refuses an email the issuer has not verified', async () => {
      assert.equal((await request(srv, { body: INIT, token: tok(OWNER, { email_verified: false }) })).status, 403);
    });

    it('closes the connection when it refuses, and does not read an unbounded body', async () => {
      const big = Buffer.alloc(8 * 1024 * 1024, 0x20);
      const r = await new Promise((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port: srv.port, path: '/mcp', method: 'POST', agent: false,
          headers: { 'content-type': 'application/json', 'content-length': big.length } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode, connection: res.headers.connection });
        });
        req.on('error', () => resolve({ error: true }));
        req.write(big.subarray(0, 1024));
        setTimeout(() => req.write(big.subarray(1024, 200_000)), 20);
        setTimeout(() => req.destroy(), 400);
      });
      assert.ok(r.error || (r.status === 401 && r.connection === 'close'), JSON.stringify(r));
    });

    it('does not invite an unauthenticated client to send its body (no 100 Continue)', async () => {
      const out = await new Promise((resolve) => {
        const sock = net.connect(srv.port, '127.0.0.1');
        let got = '';
        sock.on('connect', () => sock.write('POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n'));
        sock.on('data', c => { got += c.toString('latin1'); });
        sock.on('close', () => resolve(got));
        sock.on('error', () => resolve(got));
        setTimeout(() => sock.destroy(), 1500);
      });
      assert.ok(!out.includes('100 Continue'), out);
      assert.ok(out.includes('HTTP/1.1 401'), out);
    });

    it('invites an authenticated client to send its body', async () => {
      const out = await new Promise((resolve) => {
        const body = JSON.stringify(INIT);
        const sock = net.connect(srv.port, '127.0.0.1');
        let got = '';
        sock.on('connect', () => sock.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAuthorization: Bearer ${tok()}\r\nContent-Length: ${body.length}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`));
        sock.on('data', (c) => {
          got += c.toString('latin1');
          if (got.includes('100 Continue') && !got.includes('HTTP/1.1 200')) sock.write(body);
        });
        sock.on('close', () => resolve(got));
        sock.on('error', () => resolve(got));
        setTimeout(() => sock.destroy(), 1500);
      });
      assert.ok(out.includes('100 Continue'), out);
      assert.ok(out.includes('HTTP/1.1 200'), out);
    });

    it('refuses a user who is not listed: 403', async () => {
      const r = await request(srv, { body: INIT, token: tok(STRANGER) });
      assert.equal(r.status, 403);
      assert.equal(r.headers['mcp-session-id'], undefined);
    });

    it('accepts a valid token and serves the session', async () => {
      const t = tok();
      const sid = await session(srv, t);
      assert.ok(sid);
      assert.ok((await toolNames(srv, t, sid)).includes('list-notes'));
      const r = await call(srv, t, sid, 'list-notes');
      assert.ok(r.content[0].text.includes('hello.md'), JSON.stringify(r));
    });

    it('also requires a token for GET and DELETE', async () => {
      const t = tok();
      const sid = await session(srv, t);
      assert.equal((await request(srv, { method: 'GET', sid })).status, 401);
      assert.equal((await request(srv, { method: 'DELETE', sid })).status, 401);
      assert.equal((await request(srv, { method: 'GET', sid, token: t })).status, 200);
    });

    it('reads the token from the configured header', async () => {
      const r = await request(srv, { body: INIT, headers: { 'x-forwarded-token': tok() } });
      assert.equal(r.status, 200, r.text);
    });

    it('does not accept the token as a query parameter or a cookie', async () => {
      const t = tok();
      assert.equal((await request(srv, { path: `/mcp?access_token=${t}`, body: INIT })).status, 401);
      assert.equal((await request(srv, { body: INIT, headers: { cookie: `token=${t}` } })).status, 401);
    });

    it('refuses another user\'s token on an existing session, for the stream as well', async () => {
      const sid = await session(srv, tok(OWNER));
      assert.equal((await request(srv, { method: 'GET', sid, token: tok(VIEWER) })).status, 403);
      assert.equal((await request(srv, { method: 'GET', sid, token: tok(OWNER) })).status, 200);
    });

    it('answers a method other than POST, GET or DELETE-with-token as before: 405 once authenticated', async () => {
      const t = tok();
      const sid = await session(srv, t);
      assert.equal((await request(srv, { method: 'DELETE', sid, token: t })).status, 405);
      assert.equal((await request(srv, { method: 'PUT', path: '/mcp', body: '{}', token: t })).status, 405);
      assert.equal((await request(srv, { method: 'PUT', path: '/mcp', body: '{}' })).status, 401);
    });

    it('still turns a browser origin that is not loopback away', async () => {
      const r = await request(srv, { body: INIT, token: tok(), headers: { origin: 'https://evil.example.test' } });
      assert.equal(r.status, 403);
    });

    it('binds a session to the user who made it', async () => {
      const sid = await session(srv, tok(OWNER));
      const r = await request(srv, { body: rpc(2, 'tools/list'), token: tok(VIEWER), sid });
      assert.equal(r.status, 403);
      assert.equal((await request(srv, { body: rpc(2, 'tools/list'), token: tok(OWNER), sid })).status, 200);
    });

    it('keeps working when the same user presents a fresh token', async () => {
      const sid = await session(srv, tok(OWNER));
      assert.equal((await request(srv, { body: rpc(2, 'tools/list'), token: tok(OWNER, { exp: Math.floor(Date.now() / 1000) + 900 }), sid })).status, 200);
    });
  });

  describe('endpoints that need no token', () => {
    it('serves the protected resource metadata at both paths', async () => {
      for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const r = await request(srv, { method: 'GET', path: p });
        assert.equal(r.status, 200, p);
        assert.deepEqual(r.json, {
          resource: `http://127.0.0.1:${srv.port}/mcp`,
          authorization_servers: [iss.issuer],
          bearer_methods_supported: ['header'],
        });
      }
    });

    it('answers 404 for the stub OAuth endpoints, which would claim this server issues tokens', async () => {
      assert.equal((await request(srv, { method: 'GET', path: '/.well-known/oauth-authorization-server' })).status, 404);
      assert.equal((await request(srv, { method: 'GET', path: '/authorize?client_id=x&redirect_uri=http://127.0.0.1/cb&response_type=code' })).status, 404);
      assert.equal((await request(srv, { method: 'POST', path: '/token', body: 'grant_type=client_credentials', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 404);
      assert.equal((await request(srv, { method: 'POST', path: '/register', body: { redirect_uris: ['http://127.0.0.1/cb'] } })).status, 404);
    });

    it('leaves the upload endpoint to its own one-time token: an unknown token is 404, not 401', async () => {
      const r = await request(srv, { method: 'PUT', path: `/up/${'A'.repeat(43)}`, body: 'x', headers: { 'content-type': 'application/octet-stream' } });
      assert.equal(r.status, 404);
    });
  });

  describe('read-only users', () => {
    let viewer; let viewerSid; let owner; let ownerSid;
    before(async () => {
      viewer = tok(VIEWER);
      owner = tok(OWNER);
      viewerSid = await session(srv, viewer);
      ownerSid = await session(srv, owner);
    });

    it('are shown only the read tools, and a full user is shown all of them', async () => {
      const read = Object.keys(TOOL_ROLES).filter(n => TOOL_ROLES[n] === 'read').sort();
      assert.deepEqual((await toolNames(srv, viewer, viewerSid)).sort(), read);
      assert.deepEqual((await toolNames(srv, owner, ownerSid)).sort(), Object.keys(TOOL_ROLES).sort());
    });

    it('may call get-setup-status', async () => {
      const r = await request(srv, { body: rpc(7, 'tools/call', { name: 'get-setup-status', arguments: {} }), token: viewer, sid: viewerSid });
      assert.equal(r.status, 200);
      const result = r.msgs[0].result;
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(result.content[0].text.includes('Companion skills and agents'));
    });

    it('every tool the server lists has a role', async () => {
      for (const name of await toolNames(srv, owner, ownerSid)) assert.ok(TOOL_ROLES[name], `${name} has no role`);
    });

    it('are refused by every shape of tool name the gate sees', async () => {
      const names = ['Create-Note', ' create-note', 'create-note ', ['create-note'], { n: 1 }, 5, null, undefined, '__proto__', 'constructor'];
      for (const name of names) {
        const r = await request(srv, { body: rpc(9, 'tools/call', { name, arguments: { vault: 'v', filename: 'shape.md', content: 'x' } }), token: viewer, sid: viewerSid });
        assert.equal(r.status, 200);
        assert.equal(r.msgs[0].result.isError, true, JSON.stringify(name));
      }
      // no params at all
      const none = await request(srv, { body: { jsonrpc: '2.0', id: 9, method: 'tools/call' }, token: viewer, sid: viewerSid });
      assert.equal(none.msgs[0].result.isError, true);
      assert.equal(await fs.access(path.join(srv.vaultDir, 'shape.md')).then(() => true, () => false), false);
    });

    it('cannot get a tool through as a notification or inside a batch', async () => {
      const create = { name: 'create-note', arguments: { vault: 'v', filename: 'batch.md', content: 'x' } };
      const asNotification = await request(srv, { body: { jsonrpc: '2.0', method: 'tools/call', params: create }, token: viewer, sid: viewerSid });
      assert.equal(asNotification.status, 202);
      const batch = await request(srv, { body: [rpc(1, 'tools/call', create)], token: viewer, sid: viewerSid });
      assert.ok([202, 400].includes(batch.status), String(batch.status));
      await new Promise(r => setTimeout(r, 100));
      assert.equal(await fs.access(path.join(srv.vaultDir, 'batch.md')).then(() => true, () => false), false);
    });

    it('can call the read tools', async () => {
      const list = await call(srv, viewer, viewerSid, 'list-notes');
      assert.ok(list.content[0].text.includes('hello.md'));
      assert.ok(!list.isError);
      const note = await call(srv, viewer, viewerSid, 'read-note', { filename: 'hello.md' });
      assert.ok(note.content[0].text.includes('# Hello'));
    });

    it('are refused every tool that changes the vault, and nothing is changed', async () => {
      const attempts = [
        ['create-note', { filename: 'viewer-made.md', content: 'x' }],
        ['edit-note', { filename: 'hello.md', operation: 'append', content: 'x' }],
        ['delete-note', { filename: 'hello.md' }],
        ['move-note', { filename: 'hello.md', newFolder: 'moved' }],
        ['create-folder', { folder: 'viewer-folder' }],
        ['add-tags', { filename: 'hello.md', tags: ['a'] }],
        ['create-binary-file', { filename: 'x.bin', content: 'AAAA' }],
        ['upload-binary-file', { filename: 'x.bin', size: 1, sha256: 'a'.repeat(64) }],
        ['fetch-binary-file', { url: 'http://127.0.0.1:1/x', filename: 'x.bin' }],
        ['delete-binary-file', { filename: 'x.bin' }],
      ];
      for (const [name, args] of attempts) {
        const r = await call(srv, viewer, viewerSid, name, args);
        assert.equal(r.isError, true, name);
        assert.equal(r.content[0].text, 'This account is read-only', name);
      }
      const files = await fs.readdir(srv.vaultDir);
      assert.deepEqual(files.sort(), ['hello.md']);
      assert.equal(await fs.readFile(path.join(srv.vaultDir, 'hello.md'), 'utf8'), '# Hello\n');
    });

    it('are refused query-graph, and a tool that does not exist', async () => {
      for (const name of ['query-graph', 'a-tool-nobody-classified']) {
        const r = await call(srv, viewer, viewerSid, name, { question: 'x' });
        assert.equal(r.isError, true, name);
        assert.equal(r.content[0].text, 'This account is read-only', name);
      }
    });

    it('a full user can still change the vault', async () => {
      const r = await call(srv, owner, ownerSid, 'create-note', { filename: 'owner-made.md', content: 'x' });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.equal(await fs.readFile(path.join(srv.vaultDir, 'owner-made.md'), 'utf8').then(() => true, () => false), true);
    });
  });

  describe('the log', () => {
    it('names the reason for each refusal and the user where the token was verified, and never a token', async () => {
      const tokens = [tok(OWNER), tok(STRANGER), tok(OWNER, { exp: 1 }), tok(OWNER, { aud: 'https://elsewhere.example.test' })];
      for (const t of tokens) await request(srv, { body: INIT, token: t });
      await request(srv, { body: INIT });
      await request(srv, { body: INIT, token: 'not.a.token' });
      await until(() => srv.log().includes('reason=malformed'));
      const log = srv.log();
      const refused = log.split('\n').filter(l => l.includes('AUDIT event=login-refused'));
      const has = (...parts) => refused.some(l => parts.every(p => l.includes(p)));
      assert.ok(has('reason=no_token', 'user=-'), log);
      assert.ok(has('reason=user_not_allowed', 'user=stranger@example.test'), log);
      assert.ok(has('reason=expired', 'user=owner@example.test'), log);
      assert.ok(has('reason=wrong_audience'), log);
      assert.ok(has('reason=malformed'), log);
      const unplaced = refused.filter(l => !(l.includes('addr=127.0.0.1') && /host=[^ -]/.test(l)));
      assert.deepEqual(unplaced, [], 'each refusal names the address and host');
      for (const t of tokens) {
        assert.ok(!log.includes(t), 'a token appeared in the log');
        assert.ok(!log.includes(t.split('.')[2]), 'a signature appeared in the log');
      }
    });

    it('logs a login with the user and role where the token was accepted, then the user on each tool call', async () => {
      const sid = await session(srv, tok(OWNER));
      await until(() => srv.log().includes(`event=login user=${OWNER}`) && srv.log().includes(`sid=${sid.slice(0, 8)}`));
      const login = srv.log().split('\n').find(l => l.includes('event=login ') && l.includes(`sid=${sid.slice(0, 8)}`));
      assert.ok(login.includes(`user=${OWNER}`) && login.includes('role=full'), login);
      await call(srv, tok(OWNER), sid, 'list-vaults', {});
      await until(() => srv.log().split('\n').some(l => l.includes('event=tool-result') && l.includes(`user=${OWNER}`) && l.includes('tool=list-vaults')));
    });

    it('logs a read-only user\'s refused call as denied, with their name', async () => {
      const sid = await session(srv, tok(VIEWER));
      await call(srv, tok(VIEWER), sid, 'create-note', { filename: 'no.md', content: 'x' });
      await until(() => srv.log().split('\n').some(l => l.includes('event=denied') && l.includes(`user=${VIEWER}`) && l.includes('reason=read-only_user')));
    });

    it('logs a session used by another user as refused', async () => {
      const sid = await session(srv, tok(OWNER));
      await request(srv, { method: 'GET', sid, token: tok(VIEWER) });
      await until(() => srv.log().split('\n').some(l => l.includes('event=session-refused') && l.includes(`user=${VIEWER}`)));
    });

    it('says at start-up that authentication is on', () => {
      assert.ok(srv.log().includes('authentication on: issuer'), srv.log());
    });
  });
});

describe('resource server mode: the issuer cannot be reached', () => {
  let iss; let srv;
  before(async () => {
    iss = await createIssuer();
    iss.setDown(true);
    srv = await launch(authFor(iss));
  });
  after(async () => { await srv.stop(); await iss.stop(); });

  it('warns at start-up', async () => {
    await until(() => srv.log().includes('could not be read'));
  });

  it('answers 503, not 401, so that a client does not log in again for the server\'s fault', async () => {
    const r = await request(srv, { body: INIT, token: iss.sign(iss.claims({ email: OWNER })) });
    assert.equal(r.status, 503);
    assert.equal(r.headers['www-authenticate'], undefined);
    await until(() => srv.log().includes('reason=keys_unavailable'));
  });
});

describe('without an auth object', () => {
  let srv;
  it('warns about a setting it does not know, and starts', async () => {
    const other = await launch(() => ({ somethingElse: 1 }));
    try { assert.ok(other.log().includes('"somethingElse" is not a known setting'), other.log()); } finally { await other.stop(); }
  });

  before(async () => { srv = await launch(() => ({})); });
  after(async () => { await srv.stop(); });

  it('needs no token, as before', async () => {
    const r = await request(srv, { body: INIT });
    assert.equal(r.status, 200);
    assert.ok(r.headers['mcp-session-id']);
  });

  it('serves every tool, and keeps the discovery stubs', async () => {
    const sid = await session(srv);
    const names = await toolNames(srv, undefined, sid);
    assert.deepEqual(names.sort(), Object.keys(TOOL_ROLES).sort());
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      assert.equal((await request(srv, { method: 'GET', path: p })).status, 200, p);
    }
    assert.equal((await request(srv, { method: 'POST', path: '/register', body: { redirect_uris: ['http://127.0.0.1/cb'] } })).status, 201);
  });

  it('ignores an Authorization header', async () => {
    assert.equal((await request(srv, { body: INIT, token: 'whatever' })).status, 200);
  });

  it('says at start-up that authentication is off', () => {
    assert.ok(srv.log().includes('authentication off'), srv.log());
  });
});

describe('start-up refusals', () => {
  let iss;
  before(async () => { iss = await createIssuer(); });
  after(async () => { await iss.stop(); });

  const refused = (label, configFor, message) => it(`refuses ${label}`, async () => {
    const srv = await launch(configFor, { expectExit: true });
    try {
      assert.equal(srv.exited, true, 'the server should not have started');
      assert.equal(srv.code, 1, srv.log());
      assert.ok(srv.log().includes(message), srv.log());
    } finally { await srv.stop(); }
  });

  const withAuth = (over, top = {}) => () => ({
    ...top,
    auth: { issuer: iss.issuer, jwksUri: iss.jwksUri, audience: iss.audience, users: [OWNER], ...over },
  });

  refused('an empty user list', withAuth({ users: [] }), '"auth.users" must list at least one user');
  refused('a missing user list', withAuth({ users: undefined }), '"auth.users"');
  refused('a user who is in both lists', withAuth({ readOnlyUsers: [OWNER] }), 'also in "auth.users"');
  refused('an issuer that is plain http on a host that is not loopback', withAuth({ issuer: 'http://auth.example.test' }), '"auth.issuer" must be an https URL');
  refused('a key endpoint that is plain http on a host that is not loopback', withAuth({ jwksUri: 'http://auth.example.test/jwks' }), '"auth.jwksUri" must be an https URL');
  refused('an mcpBaseUrl that is plain http on a host that is not loopback', withAuth({}, { mcpBaseUrl: 'http://mcp.example.test' }), '"mcpBaseUrl" must be an https URL');
  refused('an unknown setting', withAuth({ usrs: ['x'] }), '"auth.usrs" is not a known setting');
  refused('credentials in the issuer URL', withAuth({ issuer: 'https://user:pw@auth.example.test' }), 'must not contain a user name or password');
  refused('an http mcpBaseUrl on a server that listens on every interface', withAuth({}, { listenHost: '0.0.0.0' }), '"listenHost" must be a loopback address');
  refused('a misspelled top-level auth setting, which would leave the server open', () => ({ Auth: { issuer: 'https://a.example.test' } }), 'looks like an authentication setting');
  refused('authentication settings placed at the top level', () => ({ users: ['x'] }), 'looks like an authentication setting');
  refused('an auth value that is not an object', () => ({ auth: true }), '"auth" must be an object');
});

// ── a configured MCP endpoint path ────────────────────────────────────────

describe('mcpPath', () => {
  let iss;
  let srv;
  const tok = (email = OWNER, over = {}) => iss.sign(iss.claims({ email, ...over }));
  const opened = (path, token) => request(srv, { path, body: INIT, token });

  before(async () => {
    iss = await createIssuer();
    srv = await launch(() => ({ ...authFor(iss)(), mcpPath: '/brain' }));
  });
  after(async () => { await srv.stop(); await iss.stop(); });

  it('answers the MCP endpoint on the configured path and not on /mcp', async () => {
    const ok = await opened('/brain', tok());
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.headers['mcp-session-id']);
    assert.equal((await opened('/mcp', tok())).status, 404);
    assert.equal((await opened('/brain/mcp', tok())).status, 404);
  });

  it('opens the notification stream on the configured path', async () => {
    const sid = (await opened('/brain', tok())).headers['mcp-session-id'];
    const r = await request(srv, { method: 'GET', path: '/brain', token: tok(), sid });
    assert.equal(r.status, 200);
    assert.equal((await request(srv, { method: 'GET', path: '/mcp', token: tok(), sid })).status, 404);
  });

  it('asks for a token on the configured path', async () => {
    const r = await opened('/brain');
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  });

  it('names the configured path as the resource, at the root and the path-suffixed address', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/brain']) {
      const r = await request(srv, { method: 'GET', path: p });
      assert.equal(r.status, 200, p);
      assert.equal(r.json.resource, `http://127.0.0.1:${srv.port}/brain`, p);
    }
    assert.equal((await request(srv, { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' })).status, 404);
  });
});

describe('mcpPath and the default audience', () => {
  let iss;
  let srv;
  before(async () => {
    iss = await createIssuer();
    srv = await launch(() => ({ ...authFor(iss, { audience: undefined })(), mcpPath: '/brain' }));
  });
  after(async () => { await srv.stop(); await iss.stop(); });

  it('accepts a token for the configured address and refuses one for /mcp', async () => {
    const good = iss.sign(iss.claims({ email: OWNER, aud: `${srv.base}/brain` }));
    const wrong = iss.sign(iss.claims({ email: OWNER, aud: `${srv.base}/mcp` }));
    assert.equal((await request(srv, { path: '/brain', body: INIT, token: good })).status, 200);
    assert.equal((await request(srv, { path: '/brain', body: INIT, token: wrong })).status, 401);
  });
});

describe('mcpPath without authentication', () => {
  let srv;
  before(async () => { srv = await launch(() => ({ mcpPath: '/x/y' })); });
  after(async () => { await srv.stop(); });

  it('serves the endpoint on the configured path only', async () => {
    assert.equal((await request(srv, { path: '/x/y', body: INIT })).status, 200);
    assert.equal((await request(srv, { path: '/mcp', body: INIT })).status, 404);
  });
});

describe('mcpPath refusals', () => {
  const refused = (label, value) => it(`refuses ${label}`, async () => {
    const srv = await launch(() => ({ mcpPath: value }), { expectExit: true });
    try {
      assert.equal(srv.exited, true, 'the server should not have started');
      assert.equal(srv.code, 1, srv.log());
      assert.ok(srv.log().includes('"mcpPath"'), srv.log());
    } finally { await srv.stop(); }
  });

  refused('a path with no leading slash', 'brain');
  refused('a path with a trailing slash', '/brain/');
  refused('the root', '/');
  refused('a path with a space', '/a b');
  refused('a path with a query', '/a?b=1');
  refused('a path with an empty segment', '/a//b');
  refused('a value that is not a string', 5);
  refused('the upload path', '/up');
  refused('a path under the upload path', '/up/x');
  refused('a path under .well-known', '/.well-known/x');
  refused('an OAuth stub path', '/token');
  refused('another OAuth stub path', '/authorize');
  refused('the registration stub path', '/register');
  refused('the .well-known root', '/.well-known');
  refused('an empty string', '');
  refused('a path with an escape', '/a%2Fb');
  refused('a path with a backslash', '/a\\b');
  refused('a path with a dot segment', '/a/./b');
  refused('a path with a parent segment', '/a/../b');
});
