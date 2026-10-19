/**
 * Tests for the tool titles, the protocol version negotiated by initialize, and the
 * MCP-Protocol-Version header. Unit tests first, then one spawned server (port 20700).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_TITLES, withTitles, titleFromName } from '../lib/tool-titles.mjs';
import { SUPPORTED_PROTOCOL_VERSIONS, negotiateProtocolVersion, protocolHeaderAcceptable } from '../lib/protocol.mjs';
import { TOOL_ROLES } from '../lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');
const PORT = 20700;

describe('withTitles', () => {
  const defs = [{ name: 'a-b', description: 'x' }, { name: 'c', annotations: { readOnlyHint: true } }];

  it('adds the title as title and as annotations.title, keeping other annotations, and leaves the input alone', () => {
    const out = withTitles(defs, { 'a-b': 'A b', c: 'C' });
    assert.deepEqual(out, [
      { name: 'a-b', description: 'x', title: 'A b', annotations: { title: 'A b' } },
      { name: 'c', title: 'C', annotations: { readOnlyHint: true, title: 'C' } },
    ]);
    assert.equal('title' in defs[0], false);
  });

  it('refuses a tool without a title, and a title without a tool', () => {
    assert.throws(() => withTitles(defs, { 'a-b': 'A b' }), /tool c has no title/);
    assert.throws(() => withTitles(defs, { 'a-b': 'A b', c: 'C', gone: 'Gone' }), /title for gone, which is not a tool/);
  });

  it('given a way to report problems, reports each and keeps going: a tool with no title gets one made from its name', () => {
    const problems = [];
    const out = withTitles(defs, { 'a-b': 'A b', gone: 'Gone' }, m => problems.push(m));
    assert.equal(problems.length, 2);
    assert.match(problems[0], /tool c has no title/);
    assert.match(problems[1], /title for gone, which is not a tool/);
    assert.deepEqual(out.map(t => [t.name, t.title, t.annotations.title]), [['a-b', 'A b', 'A b'], ['c', 'C', 'C']]);
    assert.equal(withTitles([{ name: 'read-some-thing' }], {}, () => {})[0].title, 'Read some thing');
  });

  it('does not report anything when the table is complete', () => {
    const problems = [];
    withTitles(defs, { 'a-b': 'A b', c: 'C' }, m => problems.push(m));
    assert.deepEqual(problems, []);
  });
});

describe('titleFromName', () => {
  it('turns dashes into spaces and capitalises the first letter', () => {
    assert.equal(titleFromName('read-note'), 'Read note');
    assert.equal(titleFromName('query-graph'), 'Query graph');
    assert.equal(titleFromName('x'), 'X');
  });
});

describe('TOOL_TITLES', () => {
  it('has a title for exactly the tools the server has', () => {
    assert.deepEqual(Object.keys(TOOL_TITLES).sort(), Object.keys(TOOL_ROLES).sort());
  });

  it('is words and digits separated by single spaces, with a capital first and no dash or underscore', () => {
    for (const [name, title] of Object.entries(TOOL_TITLES)) {
      assert.ok(!title.includes('-') && !title.includes('_'), `${name}: ${title}`);
      assert.match(title, /^[A-Z][A-Za-z0-9]*( [A-Za-z0-9]+)*$/, `${name}: ${title}`);
    }
  });

  it('accepts a title shape a future tool may need ("Read PDF", "Get 2 items") and refuses a dashed one', () => {
    const shape = /^[A-Z][A-Za-z0-9]*( [A-Za-z0-9]+)*$/;
    for (const ok of ['Read PDF', 'Get 2 items', 'Read note']) assert.match(ok, shape);
    for (const bad of ['read note', 'Read-note', 'Read  note', 'Read note ', '']) assert.doesNotMatch(bad, shape);
  });

  it('names the tools that list recent notes plainly', () => {
    assert.equal(TOOL_TITLES['new-notes'], 'Recently created notes');
    assert.equal(TOOL_TITLES['changed-notes'], 'Recently changed notes');
  });

  it('gives no two tools the same title', () => {
    assert.equal(new Set(Object.values(TOOL_TITLES)).size, Object.keys(TOOL_TITLES).length);
  });
});

describe('protocol versions', () => {
  it('speaks three, newest first', () => {
    assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2025-06-18', '2025-03-26', '2024-11-05']);
  });

  it('answers the version the client asked for, and the newest for anything else', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.equal(negotiateProtocolVersion(v), v);
    for (const other of ['2099-01-01', '1999-01-01', '', undefined, null, 20250618, {}, ['2024-11-05']]) {
      assert.equal(negotiateProtocolVersion(other), '2025-06-18', String(other));
    }
  });

  it('accepts a missing header and a supported one, and refuses the rest', () => {
    assert.equal(protocolHeaderAcceptable(undefined), true);
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.equal(protocolHeaderAcceptable(v), true);
    for (const bad of ['', '2020-01-01', 'latest', ' ', ',', '2025-06-18,', '2025-06-18, 2020-01-01', ['2025-06-18', '2020-01-01'], 20250618, null]) {
      assert.equal(protocolHeaderAcceptable(bad), false, String(bad));
    }
  });

  it('accepts a header sent twice or as a comma list when every version in it is supported', () => {
    assert.equal(protocolHeaderAcceptable('2025-06-18, 2024-11-05'), true);
    assert.equal(protocolHeaderAcceptable('2025-06-18,2025-06-18'), true);
    assert.equal(protocolHeaderAcceptable(['2025-06-18', '2025-03-26']), true);
  });
});

let root;
let proc;

/** One request to /mcp. Resolves with {status, headers, msgs, text}. */
function mcp({ method = 'POST', body, sid, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const h = { ...headers };
    if (bodyStr) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(bodyStr); }
    if (sid) h['mcp-session-id'] = sid;
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/mcp', method, headers: h, agent: false }, res => {
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

/** Opens the notification stream of a session; resolves once the answer headers are in. */
function openStream(sid, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/mcp', method: 'GET', headers: { 'mcp-session-id': sid, ...headers }, agent: false }, res => {
      res.resume();
      resolve({ status: res.statusCode, destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Posts a raw body (not necessarily a JSON-RPC message). */
function postRaw(sid, text) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'mcp-session-id': sid },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const init = (protocolVersion, headers) => mcp({
  body: { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
  headers,
});
const LIST = { jsonrpc: '2.0', id: '2', method: 'tools/list' };

describe('against a server', () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-test-'));
    await fs.mkdir(path.join(root, 'vault'));
    const configPath = path.join(root, 'cfg.json');
    await fs.writeFile(configPath, JSON.stringify({
      listenPort: PORT, mcpBaseUrl: `http://127.0.0.1:${PORT}`, uploadTempDir: path.join(root, 'staging'),
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

  describe('tools/list', () => {
    it('gives every tool its title, as title and as annotations.title', async () => {
      const sid = (await init('2025-06-18')).headers['mcp-session-id'];
      const tools = (await mcp({ body: LIST, sid })).msgs[0].result.tools;
      assert.equal(tools.length, Object.keys(TOOL_TITLES).length);
      for (const t of tools) {
        assert.equal(t.title, TOOL_TITLES[t.name], t.name);
        assert.equal(t.annotations.title, t.title, t.name);
        assert.ok(!/[-_]/.test(t.title), t.title);
      }
    });

    it('keeps the function names with dashes', async () => {
      const sid = (await init('2024-11-05')).headers['mcp-session-id'];
      const names = (await mcp({ body: LIST, sid })).msgs[0].result.tools.map(t => t.name);
      assert.ok(names.includes('read-note') && names.includes('upload-file'));
    });
  });

  describe('initialize', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      it(`answers ${v} to a client that asks for it`, async () => {
        assert.equal((await init(v)).msgs[0].result.protocolVersion, v);
      });
    }

    it('answers the newest version to an unknown one, and to a request that names none', async () => {
      assert.equal((await init('2099-01-01')).msgs[0].result.protocolVersion, '2025-06-18');
      const none = await mcp({ body: { jsonrpc: '2.0', id: '1', method: 'initialize', params: { capabilities: {} } } });
      assert.equal(none.msgs[0].result.protocolVersion, '2025-06-18');
    });

    it('still carries the capabilities, the server info and the instructions', async () => {
      const result = (await init('2025-03-26')).msgs[0].result;
      assert.deepEqual(result.capabilities, { tools: {} });
      assert.equal(result.serverInfo.name, 'obsidian-mcp-brain');
      assert.equal(typeof result.instructions, 'string');
    });
  });

  describe('what is not one JSON-RPC message', () => {
    it('refuses a batch, null, a number, a string and an empty array with 400 and a JSON-RPC error, running nothing', async () => {
      const sid = (await init('2025-03-26')).headers['mcp-session-id'];
      for (const text of [JSON.stringify([LIST, LIST]), '[]', 'null', '42', '"tools/list"', 'true']) {
        const r = await postRaw(sid, text);
        assert.equal(r.status, 400, text);
        assert.match(r.headers['content-type'], /application\/json/, text);
        const body = JSON.parse(r.text);
        assert.equal(body.jsonrpc, '2.0');
        assert.equal(body.id, null);
        assert.equal(body.error.code, -32600, text);
        assert.ok(!r.text.includes('data:'), 'no event stream: nothing was run');
      }
      assert.equal((await mcp({ body: LIST, sid })).status, 200, 'the session is untouched');
    });

    it('still answers invalid JSON as before, and a single message as before', async () => {
      const sid = (await init('2025-06-18')).headers['mcp-session-id'];
      const bad = await postRaw(sid, '{not json');
      assert.equal(bad.status, 400);
      assert.equal(bad.text, 'invalid json');
      assert.equal((await mcp({ body: LIST, sid })).msgs[0].id, '2');
    });
  });

  describe('the MCP-Protocol-Version header', () => {
    it('is not needed: a client that never sends it works', async () => {
      const sid = (await init('2025-06-18')).headers['mcp-session-id'];
      assert.equal((await mcp({ body: LIST, sid })).status, 200);
    });

    it('is accepted with each supported value, on POST, GET and DELETE', async () => {
      for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
        const sid = (await init(v)).headers['mcp-session-id'];
        const headers = { 'mcp-protocol-version': v };
        assert.equal((await mcp({ body: LIST, sid, headers })).status, 200, `POST ${v}`);
        const stream = await openStream(sid, headers);
        assert.equal(stream.status, 200, `GET ${v}`);
        stream.destroy();
        assert.equal((await mcp({ method: 'DELETE', sid, headers })).status, 204, `DELETE ${v}`);
      }
    });

    it('is accepted as a comma list of supported versions, and refused when one of them is not', async () => {
      const sid = (await init('2025-06-18')).headers['mcp-session-id'];
      assert.equal((await mcp({ body: LIST, sid, headers: { 'mcp-protocol-version': '2025-06-18, 2024-11-05' } })).status, 200);
      assert.equal((await mcp({ body: LIST, sid, headers: { 'mcp-protocol-version': '2025-06-18, 2020-01-01' } })).status, 400);
      assert.equal((await mcp({ body: LIST, sid, headers: { 'mcp-protocol-version': '' } })).status, 400, 'an empty value');
    });

    it('is ignored where it does not belong: the upload URL and the OAuth routes', async () => {
      const bad = { 'mcp-protocol-version': '2020-01-01' };
      const other = (method, p, headers = bad) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, headers, agent: false }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(await other('PUT', `/up/${'A'.repeat(43)}`), 404, 'an unknown upload URL is a 404');
      assert.equal(await other('GET', '/.well-known/oauth-protected-resource'), 200);
      assert.equal(await other('GET', '/.well-known/oauth-authorization-server'), 200);
      // /authorize answers by its own rules (it needs parameters); the header makes no difference.
      assert.equal(await other('GET', '/authorize'), await other('GET', '/authorize', {}));
      assert.equal(await other('POST', '/token'), 200);
      assert.equal(await other('POST', '/register'), 201);
    });

    it('is refused with 400 and a JSON error when the value is not supported, on every method', async () => {
      const sid = (await init('2025-06-18')).headers['mcp-session-id'];
      const headers = { 'mcp-protocol-version': '2020-01-01' };
      for (const request of [{ body: LIST, sid, headers }, { method: 'GET', sid, headers }, { method: 'DELETE', sid, headers }]) {
        const r = await mcp(request);
        assert.equal(r.status, 400, request.method ?? 'POST');
        assert.match(r.headers['content-type'], /application\/json/);
        assert.match(JSON.parse(r.text).error, /unsupported MCP-Protocol-Version: 2020-01-01/);
      }
      assert.equal((await mcp({ body: LIST, sid })).status, 200, 'the session is untouched');
    });

    it('is refused on initialize too, and a hostile value is shown safely', async () => {
      const r = await init('2025-06-18', { 'mcp-protocol-version': 'x'.repeat(300) });
      assert.equal(r.status, 400);
      assert.ok(JSON.parse(r.text).error.length < 200);
    });
  });
});
