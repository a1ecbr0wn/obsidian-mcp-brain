/**
 * Integration tests for bridge-native tool handlers.
 * Spawns the bridge HTTP server with a temp vault.
 * Sends real HTTP POST requests and asserts on SSE responses.
 *
 * DENY_PATHS=private is set so access-control paths can be tested alongside
 * normal paths (which use projects/, inbox/, etc.).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE     = path.join(__dirname, '..', 'obsidian-mcp-bridge.mjs');
const PORT       = 19742;
const BASE_URL   = `http://127.0.0.1:${PORT}`;
const DENY_DIR   = 'private'; // vault-relative path that DENY_PATHS blocks

let vaultDir;
let vaultName;
let bridgeProc;
let configPath;

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Writes a file directly to the temp vault.
 * @param {string} relPath - Vault-relative file path.
 * @param {string} content - File content to write.
 * @returns {Promise<void>}
 */
async function writeVaultNote(relPath, content) {
  const abs = path.join(vaultDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

/**
 * Sends a POST request to /mcp and returns the response.
 * @param {object} body - Request body as JSON object.
 * @param {string} [sid] - Optional session ID header (mcp-session-id).
 * @returns {Promise<{status: number, headers: object, msgs: object[]}>} Status code, response headers, and parsed SSE messages.
 */
async function post(body, sid, port = PORT) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (sid) headers['mcp-session-id'] = sid;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => {
          const msgs = [];
          for (const line of data.split('\n')) {
            if (line.startsWith('data: ')) {
              try { msgs.push(JSON.parse(line.slice(6))); } catch {}
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, msgs });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Initializes an MCP session via the /mcp endpoint.
 * @returns {Promise<string>} The session ID from the mcp-session-id response header.
 */
async function initSession(port = PORT) {
  const r = await post({
    jsonrpc: '2.0', id: '1', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  }, undefined, port);
  assert.equal(r.status, 200, 'initialize should return 200');
  const sid = r.headers['mcp-session-id'];
  assert.ok(sid, 'initialize should return a session ID');
  return sid;
}

/**
 * Calls a bridge-native MCP tool with the given arguments.
 * @param {string} name - Tool name to invoke.
 * @param {object} args - Tool arguments (vault name is prepended automatically).
 * @returns {Promise<object>} The MCP result object from the tool call.
 */
async function callTool(name, args) {
  const sid = await initSession();
  const r = await post({
    jsonrpc: '2.0', id: '2', method: 'tools/call',
    params: { name, arguments: { vault: vaultName, ...args } },
  }, sid);
  assert.equal(r.msgs.length, 1, `${name}: expected exactly one SSE message`);
  return r.msgs[0].result;
}

// ── global setup / teardown ───────────────────────────────────────────────

before(async () => {
  vaultDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  vaultName = path.basename(vaultDir);

  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-config-'));
  configPath = path.join(configDir, 'obsidian-mcp.json');
  await fs.writeFile(configPath, JSON.stringify({
    listenPort: PORT,
    mcpBaseUrl: BASE_URL,
    denyPaths: [DENY_DIR],
    vaults: { [vaultName]: { path: vaultDir } },
  }));

  bridgeProc = spawn('node', [BRIDGE], {
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    let out = '';
    const onData = chunk => {
      out += chunk.toString();
      if (out.includes('listening')) resolve();
    };
    bridgeProc.stdout.on('data', onData);
    bridgeProc.stderr.on('data', onData);
    bridgeProc.on('exit', code => reject(new Error(`bridge exited early with code ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`bridge startup timeout\n${out}`)), 15_000);
  });
});

after(async () => {
  bridgeProc.kill();
  await fs.rm(vaultDir, { recursive: true, force: true });
  await fs.rm(path.dirname(configPath), { recursive: true, force: true });
});

// ── list-available-vaults ─────────────────────────────────────────────────

describe('list-available-vaults', () => {
  it('returns the vault name', async () => {
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'list-available-vaults', arguments: {} },
    }, sid);
    assert.equal(r.msgs.length, 1);
    const text = r.msgs[0].result.content[0].text;
    assert.ok(text.includes(vaultName), `expected vault name in: ${text}`);
    assert.ok(!r.msgs[0].result.isError);
  });
});

// ── ping ──────────────────────────────────────────────────────────────────

describe('ping', () => {
  it('answers with an empty result', async () => {
    const sid = await initSession();
    const r = await post({ jsonrpc: '2.0', id: '2', method: 'ping' }, sid);
    assert.equal(r.msgs.length, 1);
    assert.deepEqual(r.msgs[0].result, {});
  });
});

// ── unknown method / unknown tool ───────────────────────────────────────────

describe('unrecognized requests', () => {
  it('returns a JSON-RPC Method not found error for an unknown top-level method', async () => {
    const sid = await initSession();
    const r = await post({ jsonrpc: '2.0', id: '2', method: 'not-a-real-method' }, sid);
    assert.equal(r.msgs.length, 1);
    assert.equal(r.msgs[0].error?.code, -32601);
  });

  it('returns isError for an unknown tool name', async () => {
    const result = await callTool('not-a-real-tool', {});
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Unknown tool'));
  });
});

// ── list-notes ────────────────────────────────────────────────────────────

describe('list-notes', () => {
  before(async () => {
    await writeVaultNote('inbox/todo.md', '# Todo');
    await writeVaultNote('projects/alpha.md', '# Alpha');
    await writeVaultNote('projects/beta.md', '# Beta');
    await writeVaultNote(`${DENY_DIR}/secret.md`, '# Secret');
  });

  it('returns all non-denied notes sorted', async () => {
    const result = await callTool('list-notes', {});
    const text = result.content[0].text;
    assert.ok(text.includes('inbox/todo.md'));
    assert.ok(text.includes('projects/alpha.md'));
    assert.ok(!text.includes(`${DENY_DIR}/secret.md`), 'denied notes must not appear');
    assert.ok(!result.isError);
  });

  it('scopes to a subfolder', async () => {
    const result = await callTool('list-notes', { path: 'projects' });
    const text = result.content[0].text;
    assert.ok(text.includes('projects/alpha.md'));
    assert.ok(text.includes('projects/beta.md'));
    assert.ok(!text.includes('inbox/todo.md'));
    assert.ok(!result.isError);
  });

  it('includes a tab-separated ISO 8601 last-modified timestamp on each line', async () => {
    const result = await callTool('list-notes', { path: 'projects' });
    const lines = result.content[0].text.split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const [notePath, iso] = line.split('\t');
      assert.ok(notePath.startsWith('projects/'));
      assert.ok(!Number.isNaN(Date.parse(iso)), `expected valid ISO timestamp, got: ${iso}`);
    }
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('list-notes', { path: DENY_DIR });
    assert.ok(result.isError, 'denied scope should return isError');
  });

  it('unknown vault returns isError', async () => {
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'list-notes', arguments: { vault: 'no-such-vault' } },
    }, sid);
    assert.ok(r.msgs[0].result.isError);
  });
});

// ── list-tags ─────────────────────────────────────────────────────────────

describe('list-tags', () => {
  before(async () => {
    await writeVaultNote('tagged/a.md', '---\ntags: [cooking, travel]\n---\nBody.');
    await writeVaultNote('tagged/b.md', '---\ntags:\n  - cooking\n  - photography\n---\nBody.');
    await writeVaultNote(`${DENY_DIR}/private-tags.md`, '---\ntags: [hidden]\n---\n');
  });

  it('returns unique sorted tags excluding denied paths', async () => {
    const result = await callTool('list-tags', {});
    const tags = result.content[0].text.split('\n');
    assert.ok(tags.includes('cooking'));
    assert.ok(tags.includes('travel'));
    assert.ok(tags.includes('photography'));
    assert.ok(!tags.includes('hidden'), 'tags from denied notes must not appear');
    assert.ok(!result.isError);
  });

  it('scopes to a subfolder', async () => {
    const result = await callTool('list-tags', { path: 'tagged' });
    const tags = result.content[0].text.split('\n');
    assert.ok(tags.includes('cooking'));
    assert.ok(!result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('list-tags', { path: DENY_DIR });
    assert.ok(result.isError);
  });
});

// ── search-tag ────────────────────────────────────────────────────────────

describe('search-tag', () => {
  before(async () => {
    await writeVaultNote('searchable/one.md', '---\ntags: [project, active]\n---\n');
    await writeVaultNote('searchable/two.md', '---\ntags: [project, archived]\n---\n');
    await writeVaultNote('searchable/three.md', '---\ntags: [personal]\n---\n');
    await writeVaultNote(`${DENY_DIR}/denied-tag.md`, '---\ntags: [project]\n---\n');
  });

  it('finds notes with a single tag', async () => {
    const result = await callTool('search-tag', { tags: ['project'] });
    const text = result.content[0].text;
    assert.ok(text.includes('searchable/one.md'));
    assert.ok(text.includes('searchable/two.md'));
    assert.ok(!text.includes(`${DENY_DIR}/denied-tag.md`));
    assert.ok(!result.isError);
  });

  it('requires ALL tags (AND logic)', async () => {
    const result = await callTool('search-tag', { tags: ['project', 'active'] });
    const text = result.content[0].text;
    assert.ok(text.includes('searchable/one.md'));
    assert.ok(!text.includes('searchable/two.md'), 'archived note should not match active+project');
    assert.ok(!result.isError);
  });

  it('returns no notes found when no match', async () => {
    const result = await callTool('search-tag', { tags: ['nonexistent-tag-xyz'] });
    assert.ok(result.content[0].text.includes('No notes found'));
    assert.ok(!result.isError);
  });

  it('returns isError for empty tags array', async () => {
    const result = await callTool('search-tag', { tags: [] });
    assert.ok(result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('search-tag', { tags: ['project'], path: DENY_DIR });
    assert.ok(result.isError);
  });
});

// ── new-notes / changed-notes ─────────────────────────────────────────────

describe('new-notes', () => {
  before(async () => {
    await writeVaultNote(`${DENY_DIR}/denied-new.md`, '# Secret');
  });

  it('returns notes created within default 7-day window', async () => {
    await writeVaultNote('recent/new-note.md', '# New');
    const result = await callTool('new-notes', {});
    assert.ok(result.content[0].text.includes('recent/new-note.md'));
    assert.ok(!result.isError);
  });

  it('returns notes created since a provided timestamp', async () => {
    await writeVaultNote('recent/since-note.md', '# Since');
    const since = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    const result = await callTool('new-notes', { since });
    assert.ok(result.content[0].text.includes('recent/since-note.md'));
    assert.ok(!result.isError);
  });

  it('returns isError for an invalid since timestamp', async () => {
    const result = await callTool('new-notes', { since: 'not-a-date' });
    assert.ok(result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('new-notes', { path: DENY_DIR });
    assert.ok(result.isError);
  });

  it('excludes denied notes from vault-wide results', async () => {
    const result = await callTool('new-notes', {});
    assert.ok(!result.content[0].text.includes(`${DENY_DIR}/denied-new.md`));
  });
});

describe('changed-notes', () => {
  before(async () => {
    await writeVaultNote(`${DENY_DIR}/denied-changed.md`, '# Secret');
  });

  it('returns recently modified notes', async () => {
    await writeVaultNote('recent/changed-note.md', '# Changed');
    const result = await callTool('changed-notes', {});
    assert.ok(result.content[0].text.includes('recent/changed-note.md'));
    assert.ok(!result.isError);
  });

  it('excludes notes modified before the since timestamp', async () => {
    await writeVaultNote('recent/old-note.md', '# Old');
    const since = new Date(Date.now() + 5000).toISOString(); // 5 seconds in the future
    const result = await callTool('changed-notes', { since });
    assert.ok(!result.content[0].text.includes('recent/old-note.md'));
    assert.ok(!result.isError);
  });

  it('returns isError for an invalid since timestamp', async () => {
    const result = await callTool('changed-notes', { since: 'not-a-date' });
    assert.ok(result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('changed-notes', { path: DENY_DIR });
    assert.ok(result.isError);
  });

  it('excludes denied notes from vault-wide results', async () => {
    const result = await callTool('changed-notes', {});
    assert.ok(!result.content[0].text.includes(`${DENY_DIR}/denied-changed.md`));
  });
});

// ── read-note ─────────────────────────────────────────────────────────────

describe('read-note', () => {
  before(async () => {
    await writeVaultNote('readable/hello.md', '# Hello\nsome content here');
    await writeVaultNote(`${DENY_DIR}/nope.md`, '# Secret');
  });

  it('reads an existing note', async () => {
    const result = await callTool('read-note', { folder: 'readable', filename: 'hello.md' });
    assert.ok(result.content[0].text.includes('some content here'));
    assert.ok(!result.isError);
  });

  it('includes the last-modified time as a second content item, without touching the note text', async () => {
    const result = await callTool('read-note', { folder: 'readable', filename: 'hello.md' });
    assert.equal(result.content[0].text, '# Hello\nsome content here');
    assert.ok(result.content[1].text.startsWith('Last-Modified: '));
    const iso = result.content[1].text.replace('Last-Modified: ', '');
    assert.ok(!Number.isNaN(Date.parse(iso)), `expected valid ISO timestamp, got: ${iso}`);
  });

  it('returns isError for a missing note', async () => {
    const result = await callTool('read-note', { filename: 'does-not-exist.md' });
    assert.ok(result.isError);
  });

  it('returns isError when note is in denied path', async () => {
    const result = await callTool('read-note', { folder: DENY_DIR, filename: 'nope.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError when filename is missing', async () => {
    const result = await callTool('read-note', { folder: 'readable', filename: '' });
    assert.ok(result.isError);
  });
});

// ── create-note ───────────────────────────────────────────────────────────

describe('create-note', () => {
  it('creates a new note', async () => {
    const result = await callTool('create-note', { filename: 'create-test-1.md', content: '# Created' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Created'));
    const content = await fs.readFile(path.join(vaultDir, 'create-test-1.md'), 'utf8');
    assert.equal(content, '# Created');
  });

  it('creates note with empty content when content is omitted', async () => {
    const result = await callTool('create-note', { filename: 'create-test-empty.md' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'create-test-empty.md'), 'utf8');
    assert.equal(content, '');
  });

  it('returns isError if note already exists', async () => {
    await writeVaultNote('create-test-exists.md', 'existing');
    const result = await callTool('create-note', { filename: 'create-test-exists.md', content: 'new' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already exists'));
    // Verify original content is untouched
    const content = await fs.readFile(path.join(vaultDir, 'create-test-exists.md'), 'utf8');
    assert.equal(content, 'existing');
  });

  it('creates notes in subdirectories', async () => {
    const result = await callTool('create-note', { folder: 'subdir/nested', filename: 'deep.md', content: 'deep' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'subdir/nested/deep.md'), 'utf8');
    assert.equal(content, 'deep');
  });

  it('returns isError when note is in denied path', async () => {
    const result = await callTool('create-note', { folder: DENY_DIR, filename: 'blocked.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── edit-note ─────────────────────────────────────────────────────────────

describe('edit-note', () => {
  before(async () => {
    await writeVaultNote('editable/target.md', 'original content');
  });

  it('appends content', async () => {
    await writeVaultNote('editable/append-test.md', 'line one\n');
    const result = await callTool('edit-note', { folder: 'editable', filename: 'append-test.md', operation: 'append', content: 'line two\n' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'editable/append-test.md'), 'utf8');
    assert.equal(content, 'line one\nline two\n');
  });

  it('prepends content', async () => {
    await writeVaultNote('editable/prepend-test.md', 'existing\n');
    const result = await callTool('edit-note', { folder: 'editable', filename: 'prepend-test.md', operation: 'prepend', content: 'new first\n' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'editable/prepend-test.md'), 'utf8');
    assert.equal(content, 'new first\nexisting\n');
  });

  it('replaces content', async () => {
    await writeVaultNote('editable/replace-test.md', 'old content');
    const result = await callTool('edit-note', { folder: 'editable', filename: 'replace-test.md', operation: 'replace', content: 'new content' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'editable/replace-test.md'), 'utf8');
    assert.equal(content, 'new content');
  });

  it('treats absent content as empty string (null guard)', async () => {
    await writeVaultNote('editable/null-content.md', 'base\n');
    // Omit content field — args.content will be undefined
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'edit-note', arguments: { vault: vaultName, folder: 'editable', filename: 'null-content.md', operation: 'append' } },
    }, sid);
    const result = r.msgs[0].result;
    assert.ok(!result.isError, 'missing content should not cause an error');
    const content = await fs.readFile(path.join(vaultDir, 'editable/null-content.md'), 'utf8');
    assert.equal(content, 'base\n', 'content should be unchanged when appending empty string');
  });

  it('returns isError for invalid operation', async () => {
    const result = await callTool('edit-note', { folder: 'editable', filename: 'target.md', operation: 'upsert', content: 'x' });
    assert.ok(result.isError);
  });

  it('returns isError for a missing note', async () => {
    const result = await callTool('edit-note', { filename: 'ghost.md', operation: 'append', content: 'x' });
    assert.ok(result.isError);
  });

  it('returns isError when note is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/edit-blocked.md`, 'content');
    const result = await callTool('edit-note', { folder: DENY_DIR, filename: 'edit-blocked.md', operation: 'replace', content: 'x' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── delete-note ───────────────────────────────────────────────────────────

describe('delete-note', () => {
  it('moves note to .trash by default', async () => {
    await writeVaultNote('deletable/to-trash.md', 'bye');
    const result = await callTool('delete-note', { folder: 'deletable', filename: 'to-trash.md' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('trash'));
    // file should be gone from original location
    await assert.rejects(fs.access(path.join(vaultDir, 'deletable/to-trash.md')));
    // file should be in .trash
    const trashEntries = await fs.readdir(path.join(vaultDir, '.trash'));
    assert.ok(trashEntries.some(e => e.includes('to-trash')));
  });

  it('permanently deletes when permanent=true', async () => {
    await writeVaultNote('deletable/permanent.md', 'gone');
    const result = await callTool('delete-note', { folder: 'deletable', filename: 'permanent.md', permanent: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Deleted'));
    await assert.rejects(fs.access(path.join(vaultDir, 'deletable/permanent.md')));
  });

  it('returns isError when note is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/delete-blocked.md`, 'secret');
    const result = await callTool('delete-note', { folder: DENY_DIR, filename: 'delete-blocked.md' });
    assert.ok(result.isError);
  });

  it('returns isError for missing note', async () => {
    const result = await callTool('delete-note', { filename: 'ghost.md' });
    assert.ok(result.isError);
  });
});

// ── move-note ─────────────────────────────────────────────────────────────

describe('move-note', () => {
  it('moves a note to a new location', async () => {
    await writeVaultNote('moveable/source.md', '# Source');
    const result = await callTool('move-note', {
      folder: 'moveable', filename: 'source.md',
      newFolder: 'moved', newFilename: 'destination.md',
    });
    assert.ok(!result.isError);
    await assert.rejects(fs.access(path.join(vaultDir, 'moveable/source.md')));
    const content = await fs.readFile(path.join(vaultDir, 'moved/destination.md'), 'utf8');
    assert.equal(content, '# Source');
  });

  it('rewrites wikilinks in other notes after move', async () => {
    await writeVaultNote('wikilink-src/original.md', '# Original');
    await writeVaultNote('wikilink-ref/linker.md', 'See [[original]] for details.');
    await callTool('move-note', {
      folder: 'wikilink-src', filename: 'original.md',
      newFolder: 'wikilink-dst', newFilename: 'renamed.md',
    });
    const linker = await fs.readFile(path.join(vaultDir, 'wikilink-ref/linker.md'), 'utf8');
    assert.ok(linker.includes('[[wikilink-dst/renamed]]') || linker.includes('[[renamed]]'),
      `linker should point to new name, got: ${linker}`);
  });

  it('returns isError if destination already exists', async () => {
    await writeVaultNote('collision/a.md', 'A');
    await writeVaultNote('collision/b.md', 'B');
    const result = await callTool('move-note', {
      folder: 'collision', filename: 'a.md',
      newFolder: 'collision', newFilename: 'b.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.toLowerCase().includes('exist'));
  });

  it('returns isError when source is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/move-src.md`, 'secret');
    const result = await callTool('move-note', {
      folder: DENY_DIR, filename: 'move-src.md',
      newFolder: 'inbox', newFilename: 'move-src.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError when destination is in denied path', async () => {
    await writeVaultNote('move-allowed-src.md', 'content');
    const result = await callTool('move-note', {
      filename: 'move-allowed-src.md',
      newFolder: DENY_DIR, newFilename: 'move-allowed-src.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── create-binary-file ────────────────────────────────────────────────────

describe('create-binary-file', () => {
  it('creates a new binary file from base64 content', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await callTool('create-binary-file', {
      filename: 'create-bin-1.png', content: bytes.toString('base64'),
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Created'));
    const content = await fs.readFile(path.join(vaultDir, 'create-bin-1.png'));
    assert.deepEqual(content, bytes);
  });

  it('creates binary files in subdirectories', async () => {
    const bytes = Buffer.from([0x01, 0x02, 0x03]);
    const result = await callTool('create-binary-file', {
      folder: 'attachments', filename: 'deep.png', content: bytes.toString('base64'),
    });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'attachments/deep.png'));
    assert.deepEqual(content, bytes);
  });

  it('returns isError if file already exists', async () => {
    const abs = path.join(vaultDir, 'create-bin-exists.png');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0xaa]));
    const result = await callTool('create-binary-file', {
      filename: 'create-bin-exists.png', content: Buffer.from([0xbb]).toString('base64'),
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already exists'));
    // Verify original content is untouched
    const content = await fs.readFile(abs);
    assert.deepEqual(content, Buffer.from([0xaa]));
  });

  it('returns isError when file is in denied path', async () => {
    const result = await callTool('create-binary-file', {
      folder: DENY_DIR, filename: 'blocked.png', content: Buffer.from([0x01]).toString('base64'),
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError for a .md filename', async () => {
    const result = await callTool('create-binary-file', {
      filename: 'not-binary.md', content: Buffer.from([0x01]).toString('base64'),
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('create-note'));
  });

  it('returns isError when content is not a string', async () => {
    const result = await callTool('create-binary-file', { filename: 'bad-content.png', content: 12345 });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('base64-encoded string'));
  });

  it('returns isError for malformed base64 content', async () => {
    const result = await callTool('create-binary-file', {
      filename: 'malformed.png', content: 'not valid base64!!! @#$',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('not valid base64'));
    await assert.rejects(fs.access(path.join(vaultDir, 'malformed.png')));
  });
});

// ── delete-binary-file ────────────────────────────────────────────────────

describe('delete-binary-file', () => {
  it('moves binary file to .trash by default', async () => {
    const abs = path.join(vaultDir, 'deletable-bin/to-trash.png');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x01]));
    const result = await callTool('delete-binary-file', { folder: 'deletable-bin', filename: 'to-trash.png' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('trash'));
    await assert.rejects(fs.access(abs));
    const trashEntries = await fs.readdir(path.join(vaultDir, '.trash'));
    assert.ok(trashEntries.some(e => e.includes('to-trash')));
  });

  it('permanently deletes when permanent=true', async () => {
    const abs = path.join(vaultDir, 'deletable-bin/permanent.png');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x01]));
    const result = await callTool('delete-binary-file', { folder: 'deletable-bin', filename: 'permanent.png', permanent: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Deleted'));
    await assert.rejects(fs.access(abs));
  });

  it('returns isError when file is in denied path', async () => {
    const abs = path.join(vaultDir, `${DENY_DIR}/delete-blocked.png`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x01]));
    const result = await callTool('delete-binary-file', { folder: DENY_DIR, filename: 'delete-blocked.png' });
    assert.ok(result.isError);
  });

  it('returns isError for missing file', async () => {
    const result = await callTool('delete-binary-file', { filename: 'ghost.png' });
    assert.ok(result.isError);
  });

  it('returns isError for a .md filename', async () => {
    await writeVaultNote('not-binary-del.md', 'content');
    const result = await callTool('delete-binary-file', { filename: 'not-binary-del.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('delete-note'));
  });
});

// ── move-binary-file ──────────────────────────────────────────────────────

describe('move-binary-file', () => {
  it('moves a binary file to a new location', async () => {
    const src = path.join(vaultDir, 'moveable-bin/source.png');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, Buffer.from([0x01]));
    const result = await callTool('move-binary-file', {
      folder: 'moveable-bin', filename: 'source.png',
      newFolder: 'moved-bin', newFilename: 'destination.png',
    });
    assert.ok(!result.isError);
    await assert.rejects(fs.access(src));
    const content = await fs.readFile(path.join(vaultDir, 'moved-bin/destination.png'));
    assert.deepEqual(content, Buffer.from([0x01]));
  });

  it('rewrites wikilink embeds in other notes after move', async () => {
    const src = path.join(vaultDir, 'embed-src/original.png');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, Buffer.from([0x01]));
    await writeVaultNote('embed-ref/linker.md', 'See ![[original.png]] for details.');
    await callTool('move-binary-file', {
      folder: 'embed-src', filename: 'original.png',
      newFolder: 'embed-dst', newFilename: 'renamed.png',
    });
    const linker = await fs.readFile(path.join(vaultDir, 'embed-ref/linker.md'), 'utf8');
    assert.ok(linker.includes('![[embed-dst/renamed.png]]') || linker.includes('![[renamed.png]]'),
      `linker should point to new name, got: ${linker}`);
  });

  it('returns isError if destination already exists', async () => {
    const a = path.join(vaultDir, 'collision-bin/a.png');
    const b = path.join(vaultDir, 'collision-bin/b.png');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.writeFile(a, Buffer.from([0x01]));
    await fs.writeFile(b, Buffer.from([0x02]));
    const result = await callTool('move-binary-file', {
      folder: 'collision-bin', filename: 'a.png',
      newFolder: 'collision-bin', newFilename: 'b.png',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.toLowerCase().includes('exist'));
  });

  it('returns isError when source is in denied path', async () => {
    const src = path.join(vaultDir, `${DENY_DIR}/move-src.png`);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, Buffer.from([0x01]));
    const result = await callTool('move-binary-file', {
      folder: DENY_DIR, filename: 'move-src.png',
      newFolder: 'inbox', newFilename: 'move-src.png',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError when destination is in denied path', async () => {
    const src = path.join(vaultDir, 'move-allowed-src.png');
    await fs.writeFile(src, Buffer.from([0x01]));
    const result = await callTool('move-binary-file', {
      filename: 'move-allowed-src.png',
      newFolder: DENY_DIR, newFilename: 'move-allowed-src.png',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('returns isError for a .md destination filename', async () => {
    const src = path.join(vaultDir, 'move-md-src.png');
    await fs.writeFile(src, Buffer.from([0x01]));
    const result = await callTool('move-binary-file', {
      filename: 'move-md-src.png', newFilename: 'destination.md',
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('move-note'));
  });
});

// ── find-backlinks ────────────────────────────────────────────────────────

describe('find-backlinks', () => {
  it('finds notes linking to a target note', async () => {
    await writeVaultNote('backlink-target/note.md', '# Target');
    await writeVaultNote('backlink-linker/linker.md', 'See [[note]] for details.');
    const result = await callTool('find-backlinks', { folder: 'backlink-target', filename: 'note.md' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('backlink-linker/linker.md'));
  });

  it('finds notes embedding a target binary file', async () => {
    const abs = path.join(vaultDir, 'backlink-img/photo.png');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x01]));
    await writeVaultNote('backlink-embedder/embedder.md', 'See ![[photo.png]] below.');
    const result = await callTool('find-backlinks', { folder: 'backlink-img', filename: 'photo.png' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('backlink-embedder/embedder.md'));
  });

  it('returns "No backlinks found" when nothing references the target', async () => {
    await writeVaultNote('lonely-backlink-target.md', '# Lonely');
    const result = await callTool('find-backlinks', { filename: 'lonely-backlink-target.md' });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, 'No backlinks found');
  });

  it('returns isError when target is in denied path', async () => {
    await writeVaultNote(`${DENY_DIR}/backlink-secret.md`, 'secret');
    const result = await callTool('find-backlinks', { folder: DENY_DIR, filename: 'backlink-secret.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('excludes denied notes from the results', async () => {
    await writeVaultNote('backlink-target2/note2.md', '# Target 2');
    await writeVaultNote(`${DENY_DIR}/refs-note2.md`, 'See [[note2]].');
    const result = await callTool('find-backlinks', { folder: 'backlink-target2', filename: 'note2.md' });
    assert.ok(!result.content[0].text.includes(`${DENY_DIR}/refs-note2.md`));
  });
});

// ── resolve-wikilink ──────────────────────────────────────────────────────

describe('resolve-wikilink', () => {
  it('resolves a bare basename to its full path', async () => {
    await writeVaultNote('resolve-target/unique-note.md', '# Unique');
    const result = await callTool('resolve-wikilink', { target: 'unique-note' });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, 'resolve-target/unique-note.md');
  });

  it('resolves a binary file target with its extension', async () => {
    const abs = path.join(vaultDir, 'resolve-img/unique-photo.png');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x01]));
    const result = await callTool('resolve-wikilink', { target: 'unique-photo.png' });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, 'resolve-img/unique-photo.png');
  });

  it('returns a clear message when the target does not resolve', async () => {
    const result = await callTool('resolve-wikilink', { target: 'no-such-target-anywhere' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('No file resolves wikilink target'));
  });

  it('returns multiple lines when the target is ambiguous', async () => {
    await writeVaultNote('ambig-a/dup-note.md', '# A');
    await writeVaultNote('ambig-b/dup-note.md', '# B');
    const result = await callTool('resolve-wikilink', { target: 'dup-note' });
    assert.ok(!result.isError);
    const lines = result.content[0].text.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.includes('ambig-a/dup-note.md'));
    assert.ok(lines.includes('ambig-b/dup-note.md'));
  });

  it('returns isError when target string itself looks like a denied path', async () => {
    const result = await callTool('resolve-wikilink', { target: `${DENY_DIR}/whatever` });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });

  it('excludes denied files from resolution results', async () => {
    await writeVaultNote(`${DENY_DIR}/hidden-unique-note.md`, '# Hidden');
    const result = await callTool('resolve-wikilink', { target: 'hidden-unique-note' });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('No file resolves'));
  });

  it('returns isError when target is missing', async () => {
    const result = await callTool('resolve-wikilink', {});
    assert.ok(result.isError);
  });
});

// ── create-directory ──────────────────────────────────────────────────────

describe('create-directory', () => {
  it('creates a directory (and parents)', async () => {
    const result = await callTool('create-directory', { folder: 'newdir/nested' });
    assert.ok(!result.isError);
    const stat = await fs.stat(path.join(vaultDir, 'newdir/nested'));
    assert.ok(stat.isDirectory());
  });

  it('succeeds even if directory already exists (idempotent)', async () => {
    await fs.mkdir(path.join(vaultDir, 'already-exists'), { recursive: true });
    const result = await callTool('create-directory', { folder: 'already-exists' });
    assert.ok(!result.isError);
  });

  it('returns isError when folder is in denied path', async () => {
    const result = await callTool('create-directory', { folder: `${DENY_DIR}/subdir` });
    assert.ok(result.isError);
  });

  it('returns isError when folder is missing', async () => {
    const result = await callTool('create-directory', { folder: '' });
    assert.ok(result.isError);
  });
});

// ── search-vault ──────────────────────────────────────────────────────────

describe('search-vault', () => {
  before(async () => {
    await writeVaultNote('searchable-content/a.md', 'The quick brown fox\njumps over the lazy dog');
    await writeVaultNote('searchable-content/b.md', 'Nothing matches here');
    await writeVaultNote('searchable-content/unique-filename-xyz.md', 'content');
    await writeVaultNote(`${DENY_DIR}/hidden-content.md`, 'quick brown fox');
  });

  it('returns content matches with file and line number', async () => {
    const result = await callTool('search-vault', { query: 'quick brown fox', searchType: 'content' });
    const text = result.content[0].text;
    assert.ok(text.includes('searchable-content/a.md'));
    assert.ok(text.includes(':1:'), 'should include line number');
    assert.ok(!text.includes(`${DENY_DIR}/`), 'denied files must not appear');
    assert.ok(!result.isError);
  });

  it('returns filename matches', async () => {
    const result = await callTool('search-vault', { query: 'unique-filename-xyz', searchType: 'filename' });
    const text = result.content[0].text;
    assert.ok(text.includes('unique-filename-xyz.md'));
    assert.ok(!result.isError);
  });

  it('returns both content and filename matches', async () => {
    const result = await callTool('search-vault', { query: 'unique-filename-xyz', searchType: 'both' });
    const text = result.content[0].text;
    assert.ok(text.includes('unique-filename-xyz.md'));
    assert.ok(!result.isError);
  });

  it('returns no results found when nothing matches', async () => {
    const result = await callTool('search-vault', { query: 'zzz-no-match-guaranteed', searchType: 'content' });
    assert.ok(result.content[0].text.includes('No results found'));
    assert.ok(!result.isError);
  });

  it('returns isError when path scope is denied', async () => {
    const result = await callTool('search-vault', { query: 'fox', searchType: 'content', path: DENY_DIR });
    assert.ok(result.isError);
  });

  it('returns isError for missing query', async () => {
    const result = await callTool('search-vault', { searchType: 'content' });
    assert.ok(result.isError);
  });
});

// ── add-tags ──────────────────────────────────────────────────────────────

describe('add-tags', () => {
  it('adds tags to frontmatter', async () => {
    await writeVaultNote('tag-ops/fm-add.md', '---\ntags: [existing]\n---\nBody.');
    const result = await callTool('add-tags', { files: ['tag-ops/fm-add.md'], tags: ['new-tag'], location: 'frontmatter' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/fm-add.md'), 'utf8');
    assert.ok(content.includes('new-tag'), 'new-tag should be in frontmatter');
    assert.ok(content.includes('existing'), 'existing tag should be preserved');
  });

  it('adds inline tags to content without duplicating existing ones', async () => {
    await writeVaultNote('tag-ops/inline-add.md', 'Hello world\n#already-there\n');
    const result = await callTool('add-tags', {
      files: ['tag-ops/inline-add.md'],
      tags: ['already-there', 'brand-new'],
      location: 'content',
    });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/inline-add.md'), 'utf8');
    // already-there should appear exactly once
    const matches = content.match(/#already-there/g) ?? [];
    assert.equal(matches.length, 1, 'duplicate inline tag should not be added');
    assert.ok(content.includes('#brand-new'));
  });

  it('adds tags to both frontmatter and content', async () => {
    await writeVaultNote('tag-ops/both-add.md', '---\ntags: []\n---\nBody.');
    const result = await callTool('add-tags', { files: ['tag-ops/both-add.md'], tags: ['mytag'], location: 'both' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/both-add.md'), 'utf8');
    const fmEnd = content.indexOf('---', 3);
    assert.ok(content.slice(0, fmEnd).includes('mytag'), 'tag should appear in frontmatter');
    assert.ok(content.includes('#mytag'), 'tag should appear inline');
  });

  it('blocks the call when all files are in denied paths', async () => {
    await writeVaultNote(`${DENY_DIR}/denied-add.md`, 'content');
    const result = await callTool('add-tags', {
      files: [`${DENY_DIR}/denied-add.md`],
      tags: ['new'],
    });
    // checkAccess pre-flights the call and returns isError before the per-file loop runs
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── remove-tags ───────────────────────────────────────────────────────────

describe('remove-tags', () => {
  it('removes tags from frontmatter', async () => {
    await writeVaultNote('tag-ops/fm-remove.md', '---\ntags: [keep, remove-me]\n---\nBody.');
    const result = await callTool('remove-tags', { files: ['tag-ops/fm-remove.md'], tags: ['remove-me'], location: 'frontmatter' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/fm-remove.md'), 'utf8');
    assert.ok(!content.includes('remove-me'));
    assert.ok(content.includes('keep'));
  });

  it('removes inline tags without leaving double spaces', async () => {
    await writeVaultNote('tag-ops/inline-remove.md', 'word1 #remove-me word2\n');
    const result = await callTool('remove-tags', { files: ['tag-ops/inline-remove.md'], tags: ['remove-me'], location: 'content' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/inline-remove.md'), 'utf8');
    assert.ok(!content.includes('#remove-me'));
    assert.ok(!content.includes('  '), 'should not leave double spaces');
    assert.ok(content.includes('word1') && content.includes('word2'));
  });

  it('removes standalone inline tag at start of line without leaving blank clutter', async () => {
    await writeVaultNote('tag-ops/standalone-remove.md', 'content\n#standalone-tag\nmore\n');
    const result = await callTool('remove-tags', { files: ['tag-ops/standalone-remove.md'], tags: ['standalone-tag'], location: 'content' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/standalone-remove.md'), 'utf8');
    assert.ok(!content.includes('#standalone-tag'));
  });

  it('removes tags from both frontmatter and content', async () => {
    await writeVaultNote('tag-ops/both-remove.md', '---\ntags: [zap]\n---\nBody #zap here.');
    const result = await callTool('remove-tags', { files: ['tag-ops/both-remove.md'], tags: ['zap'], location: 'both' });
    assert.ok(!result.isError);
    const content = await fs.readFile(path.join(vaultDir, 'tag-ops/both-remove.md'), 'utf8');
    assert.ok(!content.includes('zap'), 'tag should be removed from both frontmatter and content');
  });

  it('blocks the call when all files are in denied paths', async () => {
    await writeVaultNote(`${DENY_DIR}/denied-remove.md`, '---\ntags: [old]\n---\n');
    const result = await callTool('remove-tags', { files: [`${DENY_DIR}/denied-remove.md`], tags: ['old'] });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Access denied'));
  });
});

// ── rename-tag ────────────────────────────────────────────────────────────

describe('rename-tag', () => {
  it('renames a tag across the vault and reports count', async () => {
    const oldTag = 'rename-old-unique';
    const newTag = 'rename-new-unique';
    await writeVaultNote('renameables/x.md', `---\ntags: [${oldTag}]\n---\nInline #${oldTag} here.`);
    await writeVaultNote('renameables/y.md', `---\ntags: [${oldTag}, other]\n---\n`);

    const result = await callTool('rename-tag', { oldTag, newTag });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /\bin 2 note/, 'should report 2 notes updated');

    const x = await fs.readFile(path.join(vaultDir, 'renameables/x.md'), 'utf8');
    const y = await fs.readFile(path.join(vaultDir, 'renameables/y.md'), 'utf8');
    assert.ok(!x.includes(oldTag));
    assert.ok(x.includes(newTag));
    assert.ok(!y.includes(oldTag));
    assert.ok(y.includes(newTag));
  });

  it('returns isError when oldTag is missing', async () => {
    const result = await callTool('rename-tag', { oldTag: '', newTag: 'something' });
    assert.ok(result.isError);
  });

  it('returns isError for unknown vault', async () => {
    const sid = await initSession();
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'rename-tag', arguments: { vault: 'wrong-vault', oldTag: 'x', newTag: 'y' } },
    }, sid);
    assert.ok(r.msgs[0].result.isError);
  });
});

// ── query-graph ───────────────────────────────────────────────────────────
// The main bridge instance above has no graphify-out/ in its vault, so query-graph
// should never appear for it. The positive-path tests spawn a dedicated second bridge
// instance whose vault does have graphify-out/, with a mock `graphify` binary on PATH.

describe('query-graph (no graph built)', () => {
  it('is listed in tools/list regardless (availability is per-vault, per-call)', async () => {
    const sid = await initSession();
    const r = await post({ jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} }, sid);
    const names = r.msgs[0].result.tools.map(t => t.name);
    assert.ok(names.includes('query-graph'));
  });

  it('returns a clear isError when the vault has no graph', async () => {
    const result = await callTool('query-graph', { question: 'anything' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('graph.json not found'));
  });
});

describe('query-graph (graph built)', () => {
  const GPORT = 19744;
  const GBASE_URL = `http://127.0.0.1:${GPORT}`;
  let gVaultDir, gVaultName, gProc, gMockBinDir, gConfigDir;

  async function gCallTool(name, args) {
    const sid = await initSession(GPORT);
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name, arguments: { vault: gVaultName, ...args } },
    }, sid, GPORT);
    assert.equal(r.msgs.length, 1);
    return r.msgs[0].result;
  }

  before(async () => {
    gVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-graphify-test-'));
    gVaultName = path.basename(gVaultDir);
    await fs.mkdir(path.join(gVaultDir, 'graphify-out'), { recursive: true });
    await fs.writeFile(path.join(gVaultDir, 'graphify-out', 'graph.json'), '{}');

    gMockBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-graphify-bin-'));
    const mockPath = path.join(gMockBinDir, 'graphify');
    await fs.writeFile(mockPath, [
      '#!/usr/bin/env node',
      "const question = process.argv[3];", // argv: node, script, 'query', question — matches graphify's real sys.argv[2]
      "if (question === '__FAIL__') {",
      "  process.stderr.write('mock failure\\n');",
      '  process.exit(1);',
      "} else if (question === '__HANG__') {",
      '  setTimeout(() => {}, 10000);',
      '} else {',
      "  process.stdout.write('Answer: ' + question);",
      '}',
      '',
    ].join('\n'));
    await fs.chmod(mockPath, 0o755);

    gConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-graphify-config-'));
    const gConfigPath = path.join(gConfigDir, 'obsidian-mcp.json');
    await fs.writeFile(gConfigPath, JSON.stringify({
      listenPort: GPORT,
      mcpBaseUrl: GBASE_URL,
      graphifyQueryTimeoutMs: 300,
      vaults: { [gVaultName]: { path: gVaultDir } },
    }));

    gProc = spawn('node', [BRIDGE], {
      env: {
        ...process.env,
        PATH:        `${gMockBinDir}:${process.env.PATH}`,
        CONFIG_PATH: gConfigPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      let out = '';
      const onData = chunk => { out += chunk.toString(); if (out.includes('listening')) resolve(); };
      gProc.stdout.on('data', onData);
      gProc.stderr.on('data', onData);
      gProc.on('exit', code => reject(new Error(`graphify bridge exited early with code ${code}\n${out}`)));
      setTimeout(() => reject(new Error(`graphify bridge startup timeout\n${out}`)), 15_000);
    });
  });

  after(async () => {
    gProc.kill();
    await fs.rm(gVaultDir, { recursive: true, force: true });
    await fs.rm(gMockBinDir, { recursive: true, force: true });
    await fs.rm(gConfigDir, { recursive: true, force: true });
  });

  it('is listed in tools/list', async () => {
    const sid = await initSession(GPORT);
    const r = await post({ jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} }, sid, GPORT);
    const names = r.msgs[0].result.tools.map(t => t.name);
    assert.ok(names.includes('query-graph'));
  });

  it('returns the mock graphify output for a successful query', async () => {
    const result = await gCallTool('query-graph', { question: 'What is X?' });
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, 'Answer: What is X?');
  });

  it('returns isError when graphify exits non-zero', async () => {
    const result = await gCallTool('query-graph', { question: '__FAIL__' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('exited with code'));
  });

  it('returns isError on timeout', async () => {
    const result = await gCallTool('query-graph', { question: '__HANG__' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('timed out'));
  });

  it('returns isError when graph.json is missing at call time', async () => {
    const graphJsonPath = path.join(gVaultDir, 'graphify-out', 'graph.json');
    await fs.rename(graphJsonPath, `${graphJsonPath}.bak`);
    try {
      const result = await gCallTool('query-graph', { question: 'anything' });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes('graph.json not found'));
    } finally {
      await fs.rename(`${graphJsonPath}.bak`, graphJsonPath);
    }
  });

  it('returns isError when question is missing', async () => {
    const result = await gCallTool('query-graph', {});
    assert.ok(result.isError);
  });
});

// ── multi-vault configuration ────────────────────────────────────────────
// A dedicated third bridge instance configured with two vaults: "alpha" has no
// deny paths of its own (inherits only the global list), "beta" adds its own
// deny path on top of the global one — proving the global+per-vault merge.

describe('multi-vault configuration', () => {
  const MPORT = 19745;
  const MBASE_URL = `http://127.0.0.1:${MPORT}`;
  let mAlphaDir, mBetaDir, mProc, mConfigDir;

  async function mCallTool(vault, name, args) {
    const sid = await initSession(MPORT);
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name, arguments: { vault, ...args } },
    }, sid, MPORT);
    assert.equal(r.msgs.length, 1);
    return r.msgs[0].result;
  }

  before(async () => {
    mAlphaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-multivault-alpha-'));
    mBetaDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-multivault-beta-'));
    await fs.mkdir(path.join(mAlphaDir, 'globally-denied'), { recursive: true });
    await fs.writeFile(path.join(mAlphaDir, 'globally-denied', 'secret.md'), '# Secret');
    await fs.writeFile(path.join(mAlphaDir, 'visible.md'), '# Visible');
    await fs.mkdir(path.join(mBetaDir, 'beta-only-denied'), { recursive: true });
    await fs.writeFile(path.join(mBetaDir, 'beta-only-denied', 'secret.md'), '# Beta secret');
    await fs.writeFile(path.join(mBetaDir, 'visible.md'), '# Visible');

    mConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-multivault-config-'));
    const mConfigPath = path.join(mConfigDir, 'obsidian-mcp.json');
    await fs.writeFile(mConfigPath, JSON.stringify({
      listenPort: MPORT,
      mcpBaseUrl: MBASE_URL,
      denyPaths: ['globally-denied'],
      vaults: {
        alpha: { path: mAlphaDir },
        beta:  { path: mBetaDir, denyPaths: ['beta-only-denied'] },
      },
    }));

    mProc = spawn('node', [BRIDGE], {
      env: { ...process.env, CONFIG_PATH: mConfigPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      let out = '';
      const onData = chunk => { out += chunk.toString(); if (out.includes('listening')) resolve(); };
      mProc.stdout.on('data', onData);
      mProc.stderr.on('data', onData);
      mProc.on('exit', code => reject(new Error(`multi-vault bridge exited early with code ${code}\n${out}`)));
      setTimeout(() => reject(new Error(`multi-vault bridge startup timeout\n${out}`)), 15_000);
    });
  });

  after(async () => {
    mProc.kill();
    await fs.rm(mAlphaDir, { recursive: true, force: true });
    await fs.rm(mBetaDir, { recursive: true, force: true });
    await fs.rm(mConfigDir, { recursive: true, force: true });
  });

  it('list-available-vaults lists every configured vault', async () => {
    const sid = await initSession(MPORT);
    const r = await post({
      jsonrpc: '2.0', id: '2', method: 'tools/call',
      params: { name: 'list-available-vaults', arguments: {} },
    }, sid, MPORT);
    const text = r.msgs[0].result.content[0].text;
    assert.ok(text.includes('alpha'));
    assert.ok(text.includes('beta'));
  });

  it('serves each vault from its own configured path', async () => {
    const alphaResult = await mCallTool('alpha', 'read-note', { filename: 'visible.md' });
    assert.ok(!alphaResult.isError);
    assert.equal(alphaResult.content[0].text, '# Visible');

    const betaResult = await mCallTool('beta', 'read-note', { filename: 'visible.md' });
    assert.ok(!betaResult.isError);
    assert.equal(betaResult.content[0].text, '# Visible');
  });

  it('applies the global deny list to every vault', async () => {
    const alphaResult = await mCallTool('alpha', 'read-note', { folder: 'globally-denied', filename: 'secret.md' });
    assert.ok(alphaResult.isError);
    assert.ok(alphaResult.content[0].text.includes('Access denied'));

    // beta has no "globally-denied" folder, but list-notes scoped there should
    // still be denied rather than erroring for a missing folder — global deny
    // paths apply vault-wide regardless of whether the vault happens to have that folder.
    const betaScoped = await mCallTool('beta', 'list-notes', { path: 'globally-denied' });
    assert.ok(betaScoped.isError);
    assert.ok(betaScoped.content[0].text.includes('Access denied'));
  });

  it('applies a per-vault deny path only to that vault', async () => {
    const betaResult = await mCallTool('beta', 'read-note', { folder: 'beta-only-denied', filename: 'secret.md' });
    assert.ok(betaResult.isError);
    assert.ok(betaResult.content[0].text.includes('Access denied'));

    // alpha has no such restriction — an equivalent path there is not denied
    // (it simply doesn't exist, so the call fails with a not-found error instead).
    const alphaResult = await mCallTool('alpha', 'read-note', { folder: 'beta-only-denied', filename: 'secret.md' });
    assert.ok(alphaResult.isError);
    assert.ok(!alphaResult.content[0].text.includes('Access denied'));
  });

  it('returns isError for an unknown vault name', async () => {
    const result = await mCallTool('no-such-vault', 'read-note', { filename: 'visible.md' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Unknown vault'));
  });
});
