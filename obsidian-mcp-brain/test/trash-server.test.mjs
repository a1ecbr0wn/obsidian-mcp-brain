/**
 * Integration tests for the .trash purge and the timestamped names the delete tools give.
 * Spawns real servers with their own vaults and ports (20600 and up).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'obsidian-mcp-brain.mjs');

let nextPort = 20600;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const exists = (p) => fs.access(p).then(() => true, () => false);

async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Starts a server on a fresh root. `prepare(root)` runs first, to fill the vaults;
 * `config(root)` returns the settings merged over the defaults.
 */
async function startServer({ prepare, config = () => ({}) } = {}) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trash-srv-'));
  await fs.mkdir(path.join(root, 'vault'));
  await prepare?.(root);
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port, mcpBaseUrl: `http://127.0.0.1:${port}`, uploadTempDir: path.join(root, 'staging'),
    vaults: { v: { path: path.join(root, 'vault') } }, ...config(root),
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', c => { log += c.toString(); });
  proc.stderr.on('data', c => { log += c.toString(); });
  const exited = new Promise(resolve => proc.once('exit', code => resolve(code)));
  await Promise.race([
    until(() => log.includes('listening'), 'the server to listen', 15_000),
    exited.then(code => { throw new Error(`server exited early with code ${code}\n${log}`); }),
  ]);
  return {
    port, root, vault: path.join(root, 'vault'), log: () => log,
    async stop() {
      if (proc.exitCode === null) await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Starts a server that should refuse its config; resolves with its exit code and output. */
async function startRefused(config) {
  const port = nextPort++;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trash-srv-'));
  await fs.mkdir(path.join(root, 'vault'));
  const configPath = path.join(root, 'cfg.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: port, mcpBaseUrl: `http://127.0.0.1:${port}`, uploadTempDir: path.join(root, 'staging'),
    vaults: { v: { path: path.join(root, 'vault') } }, ...config,
  }));
  const proc = spawn('node', [SERVER_ENTRY], { env: { ...process.env, CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', c => { out += c.toString(); });
  proc.stderr.on('data', c => { out += c.toString(); });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 6000);
  const code = await new Promise(resolve => proc.on('exit', resolve));
  clearTimeout(timer);
  await fs.rm(root, { recursive: true, force: true });
  return { code, out };
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
  const r = await mcpPost(srv.port, { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name, arguments: { vault: 'v', ...args } } }, init.headers['mcp-session-id']);
  return r.msgs[0].result;
}

describe('the .trash purge at start-up', () => {
  const ran = (srv, vault, days) => srv.log().includes(`trash purge of ${vault}: 0 file(s) older than ${days} day(s) removed`);

  it('runs shortly after start-up with the default of 30 days, and keeps files that are new', async () => {
    const young = 'young_1700000000000.pdf'; // a name that claims to be old does not make a new file old
    const srv = await startServer({
      prepare: async (root) => {
        const trash = path.join(root, 'vault', '.trash');
        await fs.mkdir(path.join(trash, 'sub'), { recursive: true });
        await fs.writeFile(path.join(trash, young), 'young');
        await fs.writeFile(path.join(trash, 'sub', 'nested.md'), 'nested');
        await fs.writeFile(path.join(root, 'vault', 'note.md'), '# keep\n');
      },
    });
    try {
      await until(() => ran(srv, 'v', 30), 'the purge to run');
      assert.equal(await exists(path.join(srv.vault, '.trash', young)), true);
      assert.equal(await exists(path.join(srv.vault, '.trash/sub/nested.md')), true);
      assert.equal(await exists(path.join(srv.vault, 'note.md')), true);
      assert.ok(!srv.log().includes('event=trash-purge'), 'nothing was removed, so nothing is audited');
    } finally { await srv.stop(); }
  });

  it('uses trashRetentionDays from the config', async () => {
    const srv = await startServer({ config: () => ({ trashRetentionDays: 7 }) });
    try {
      await until(() => ran(srv, 'v', 7), 'the purge to run with 7 days');
    } finally { await srv.stop(); }
  });

  it('does not purge when trashRetentionDays is 0', async () => {
    const srv = await startServer({
      config: () => ({ trashRetentionDays: 0 }),
      prepare: async (root) => {
        await fs.mkdir(path.join(root, 'vault', '.trash'));
        await fs.writeFile(path.join(root, 'vault', '.trash', 'a.pdf'), 'x');
      },
    });
    try {
      await sleep(2500);
      assert.ok(!srv.log().includes('trash purge of'), srv.log());
      assert.equal(await exists(path.join(srv.vault, '.trash', 'a.pdf')), true);
    } finally { await srv.stop(); }
  });

  it('lets a vault override the server-wide setting, 0 included', async () => {
    const srv = await startServer({
      config: (root) => ({
        trashRetentionDays: 10,
        vaults: {
          v: { path: path.join(root, 'vault'), trashRetentionDays: 5 },
          keep: { path: path.join(root, 'keep'), trashRetentionDays: 0 },
          plain: { path: path.join(root, 'plain') },
        },
      }),
      prepare: async (root) => {
        for (const d of ['keep', 'plain']) await fs.mkdir(path.join(root, d));
      },
    });
    try {
      await until(() => ran(srv, 'plain', 10) && ran(srv, 'v', 5), 'the purge of both vaults');
      assert.ok(!srv.log().includes('trash purge of keep'), 'a vault set to 0 is skipped');
    } finally { await srv.stop(); }
  });

  it('reports a .trash that is a link, does not follow it, and still serves', async () => {
    const srv = await startServer({
      prepare: async (root) => {
        await fs.mkdir(path.join(root, 'elsewhere'));
        await fs.writeFile(path.join(root, 'elsewhere', 'victim.pdf'), 'x');
        await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'vault', '.trash'));
      },
    });
    try {
      await until(() => srv.log().includes('trash purge of v failed: .trash is not a real folder'), 'the refusal');
      assert.equal(await exists(path.join(srv.root, 'elsewhere', 'victim.pdf')), true);
      assert.ok(!(await callTool(srv, 'list-vaults', {})).isError);
    } finally { await srv.stop(); }
  });
});

describe('trashRetentionDays setting', () => {
  for (const bad of [-1, 1.5, '30', true, {}, [7], null]) {
    it(`refuses ${JSON.stringify(bad)}, and the server does not start`, async () => {
      const r = await startRefused({ trashRetentionDays: bad });
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes('"trashRetentionDays" must be a whole number of days, 0 or more'), r.out);
    });
  }

  it('refuses a bad value for a single vault, naming it', async () => {
    const r = await startRefused({ vaults: { v: { path: '/tmp', trashRetentionDays: -3 } } });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('vaults.v.trashRetentionDays must be a whole number of days'), r.out);
  });
});

describe('what the delete tools put in .trash', () => {
  it('names the file by the time, also the first one', async () => {
    const srv = await startServer({
      config: () => ({ trashRetentionDays: 0 }),
      prepare: async (root) => {
        await fs.writeFile(path.join(root, 'vault', 'doc.md'), '# doc\n');
        await fs.writeFile(path.join(root, 'vault', 'pic.png'), Buffer.from([1, 2, 3]));
      },
    });
    try {
      assert.ok(!(await callTool(srv, 'delete-note', { filename: 'doc.md' })).isError);
      assert.ok(!(await callTool(srv, 'delete-file', { filename: 'pic.png' })).isError);
      const names = await fs.readdir(path.join(srv.vault, '.trash'));
      assert.ok(names.some(n => /^doc_\d{13}\.md$/.test(n)), names.join(','));
      assert.ok(names.some(n => /^pic_\d{13}\.png$/.test(n)), names.join(','));
    } finally { await srv.stop(); }
  });
});
