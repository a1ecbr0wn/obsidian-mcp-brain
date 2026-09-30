// Smoke test for the container image: starts a container from it with a throwaway
// config and vault, and checks that it becomes healthy, serves the MCP discovery
// document and tools, reads and writes the mounted vault, and shuts down cleanly.
//
//   docker build -t obsidian-mcp-brain:ci .
//   node docker/smoke-test.mjs obsidian-mcp-brain:ci
//
// Needs the docker CLI and Node 18+. The container runs as the caller's own UID/GID,
// as an operator would with --user, so the vault the caller owns is writable inside it.
// Set SMOKE_PORT to change the host port (default 13002).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const image = process.argv[2];
if (!image) {
  console.error('usage: node docker/smoke-test.mjs <image>');
  process.exit(2);
}

const PORT = Number(process.env.SMOKE_PORT ?? 13002);
const NAME = `omb-smoke-${process.pid}`;
const VAULT_NAME = 'knowledge';

/**
 * Runs the docker CLI and returns its trimmed stdout.
 * @param {string[]} args - Arguments to pass to docker.
 * @returns {string} Trimmed standard output.
 * @throws {Error} When docker exits non-zero.
 */
function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * Returns the container's log output. `docker logs` replays the container's stderr on
 * this process's stderr, so both streams are needed to see a startup failure.
 * @returns {string} Combined stdout and stderr of the container.
 */
function logs() {
  const r = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

/**
 * Sends one JSON-RPC message to the container's /mcp endpoint.
 * @param {object} body - The JSON-RPC request.
 * @param {string} [sid] - Session ID from a previous initialize.
 * @returns {Promise<{sid: string|null, result: object}>} The session ID header and the first SSE message's result.
 */
async function rpc(body, sid) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  assert.ok(line, `no SSE message in response (HTTP ${res.status}): ${text}`);
  return { sid: res.headers.get('mcp-session-id'), result: JSON.parse(line.slice(6)).result };
}

/**
 * Waits until the container's health status is "healthy".
 * @param {number} timeoutMs - How long to wait before giving up.
 * @throws {Error} When the container stops running, reports unhealthy, or the wait times out.
 */
async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [state, status] = docker('inspect', NAME, '--format', '{{.State.Status}} {{.State.Health.Status}}').split(' ');
    // A container that crashed at startup never leaves the "starting" health state,
    // so check that it is still running rather than waiting out the timeout.
    if (state !== 'running') throw new Error(`container is ${state}, not running:\n${logs()}`);
    if (status === 'healthy') return;
    if (status === 'unhealthy') throw new Error(`container is unhealthy:\n${logs()}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`container did not become healthy within ${timeoutMs}ms:\n${logs()}`);
}

const dir = mkdtempSync(join(tmpdir(), 'omb-smoke-'));
try {
  const vault = join(dir, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, 'hello.md'), '# hello\n');
  // A graph file to trigger query-graph to invoke the graphify CLI (not available in container).
  mkdirSync(join(vault, 'graphify-out'));
  writeFileSync(join(vault, 'graphify-out', 'graph.json'), '{}');
  const config = join(dir, 'obsidian-mcp.json');
  writeFileSync(config, JSON.stringify({
    listenHost: '0.0.0.0',
    mcpBaseUrl: `http://127.0.0.1:${PORT}`,
    vaults: { [VAULT_NAME]: { path: `/vaults/${VAULT_NAME}` } },
  }));
  chmodSync(dir, 0o755);
  chmodSync(config, 0o644);

  docker(
    'run', '-d', '--name', NAME,
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${vault}:/vaults/${VAULT_NAME}`,
    '-v', `${config}:/config/obsidian-mcp.json:ro`,
    '-p', `127.0.0.1:${PORT}:3002`,
    image,
  );

  await waitHealthy(90_000);
  console.log('ok: container is healthy');

  const discovery = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`);
  assert.equal(discovery.status, 200, 'discovery endpoint should return 200');
  console.log('ok: discovery endpoint reachable from the host');

  const init = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  });
  assert.ok(init.sid, 'initialize should return a session ID');

  const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid)).result.tools;
  assert.ok(tools.some(t => t.name === 'read-note'), 'tools/list should include read-note');
  console.log(`ok: tools/list returned ${tools.length} tools`);

  const call = async (name, args) =>
    (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: { vault: VAULT_NAME, ...args } } }, init.sid)).result;

  const read = await call('read-note', { filename: 'hello.md' });
  assert.ok(!read.isError && read.content[0].text.includes('# hello'), 'read-note should return the mounted note');

  const create = await call('create-note', { filename: 'from-container.md', content: '# made in the container\n' });
  assert.ok(!create.isError, `create-note failed: ${JSON.stringify(create)}`);
  assert.equal(readFileSync(join(vault, 'from-container.md'), 'utf8'), '# made in the container\n');
  console.log('ok: vault is readable and writable through the mount');

  const graph = await call('query-graph', { question: 'anything' });
  assert.ok(graph.isError && /graphify command not found/.test(graph.content[0].text), `query-graph should report that the graphify command is not found, got ${JSON.stringify(graph)}`);
  console.log('ok: query-graph reports graphify command not found');

  docker('stop', NAME);
  const exit = docker('inspect', NAME, '--format', '{{.State.ExitCode}}');
  assert.ok(exit === '143' || exit === '0', `docker stop should end in a clean exit, got ${exit} (137 means SIGKILL)`);
  console.log(`ok: clean shutdown (exit code ${exit})`);
} finally {
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
console.log('smoke test passed');
