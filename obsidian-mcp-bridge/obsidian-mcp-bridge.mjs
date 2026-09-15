#!/usr/bin/env node
/**
 * MCP HTTP bridge for one or more Obsidian vaults.
 * Replaces both mcp-proxy and mcp-oauth-proxy, and the obsidian-mcp child process:
 *   - Implements MCP Streamable HTTP transport (2024-11-05 spec)
 *   - Provides the OAuth 2.0 discovery endpoints Claude Code requires
 *   - Reads and writes vault files directly, with no child process dependency
 *
 * Usage: node obsidian-mcp-bridge.mjs
 * Configuration is read from a JSON file — see loadConfig() below for its shape,
 * location, and validation. CONFIG_PATH is the only environment variable read.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { normPath, isDenied as _isDenied, checkAccess as _checkAccess } from './lib/access.mjs';
import { parseTags as fmParseTags, addTags as fmAddTags, removeTags as fmRemoveTags, renameTag as fmRenameTag } from './lib/frontmatter.mjs';
import { escRe } from './lib/utils.mjs';
import {
  walkVault as libWalkVault,
  readNote as libReadNote,
  writeNote as libWriteNote,
  deleteNote as libDeleteNote,
  moveNote as libMoveNote,
  searchContent as libSearchContent,
  searchFilename as libSearchFilename,
  writeBinaryFile as libWriteBinaryFile,
  deleteBinaryFile as libDeleteBinaryFile,
  moveBinaryFile as libMoveBinaryFile,
  findBacklinks as libFindBacklinks,
  resolveWikilink as libResolveWikilink,
} from './lib/vault.mjs';

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const logErr = (...a) => console.error(ts(), ...a);

// ── Configuration (JSON file, not environment variables) ────────────────────
//
// CONFIG_PATH is the one setting still read from the environment, because
// something has to say where to find the file that contains everything else.
// Shape:
//   {
//     "listenPort": 3002,
//     "mcpBaseUrl": "https://host:4001",
//     "denyPaths": ["private"],
//     "graphifyQueryTimeoutMs": 60000,
//     "vaults": { "name": { "path": "/abs/path", "denyPaths": [] } }
//   }
// mcpBaseUrl and a non-empty vaults map (each with a path) are required;
// everything else has a default. Invalid or missing config exits the process,
// matching this file's existing synchronous-startup-validation style.

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(os.homedir(), '.config', 'obsidian-mcp.json');

function normDenyPaths(list, configPath, fieldLabel) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some(p => typeof p !== 'string')) {
    logErr(`Config file at ${configPath}: "${fieldLabel}" must be an array of strings`);
    process.exit(1);
  }
  return list
    .map(p => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function loadConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    logErr(`Could not read config file at ${configPath}: ${err.message}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    logErr(`Config file at ${configPath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!config.mcpBaseUrl) {
    logErr(`Config file at ${configPath} must set "mcpBaseUrl" to the public HTTPS base URL of this bridge (e.g. https://hostname:4001)`);
    process.exit(1);
  }

  const listenPort = parseInt(config.listenPort ?? 3002, 10);
  if (Number.isNaN(listenPort) || listenPort < 1 || listenPort > 65535) {
    logErr(`Config file at ${configPath}: "listenPort" must be a valid port number (1-65535)`);
    process.exit(1);
  }

  const graphifyQueryTimeoutMs = parseInt(config.graphifyQueryTimeoutMs ?? 60000, 10);
  if (Number.isNaN(graphifyQueryTimeoutMs) || graphifyQueryTimeoutMs < 1) {
    logErr(`Config file at ${configPath}: "graphifyQueryTimeoutMs" must be a positive number`);
    process.exit(1);
  }

  const globalDenyPaths = normDenyPaths(config.denyPaths, configPath, 'denyPaths');

  const rawVaults = config.vaults;
  if (!rawVaults || typeof rawVaults !== 'object' || Array.isArray(rawVaults) || Object.keys(rawVaults).length === 0) {
    logErr(`Config file at ${configPath} must set "vaults" to a non-empty object of the form { "name": { "path": "/abs/path" } }`);
    process.exit(1);
  }

  const vaults = {};
  for (const [name, entry] of Object.entries(rawVaults)) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) {
      logErr(`Config file at ${configPath}: vault "${name}" must have a "path" string`);
      process.exit(1);
    }
    vaults[name] = {
      path: entry.path,
      denyPaths: [...globalDenyPaths, ...normDenyPaths(entry.denyPaths, configPath, `vaults.${name}.denyPaths`)],
    };
  }

  return {
    listenPort,
    baseUrl: config.mcpBaseUrl,
    graphifyQueryTimeoutMs,
    vaults,
  };
}

const { listenPort: LISTEN_PORT, baseUrl: BASE_URL, graphifyQueryTimeoutMs: GRAPHIFY_QUERY_TIMEOUT_MS, vaults: VAULTS } = loadConfig(CONFIG_PATH);

// ── Path access control ────────────────────────────────────────────────────

// Resolves args.vault's effective (global + per-vault) deny list before calling
// the shared, vault-agnostic checkAccess/isDenied functions. An unrecognised
// vault name falls back to an empty deny list here — the request fails
// downstream anyway ("Unknown vault"), so there's nothing extra to protect.
const checkAccess = (toolName, args) => _checkAccess(VAULTS[args.vault]?.denyPaths ?? [], toolName, args);

const toolOk  = (res, sid, id, text) => sendSse(res, 200, sid, [{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }]);
const toolErr = (res, sid, id, text) => sendSse(res, 200, sid, [{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }]);

// Static initialize response — every tool is bridge-native, so there's no child
// capabilities negotiation to wait on.
const SERVER_CAPS = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'obsidian-mcp-bridge', version: '1.0.0' },
};

// ── Bridge-native tools ────────────────────────────────────────────────────


const BRIDGE_TOOLS = [
  {
    name: 'list-notes',
    description: 'List all notes in the vault, or scoped to a folder. Returns sorted vault-relative paths, each with a tab-separated ISO 8601 last-modified timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name' },
        path:  { type: 'string', description: 'Optional vault-relative folder to scope the listing' },
      },
      required: ['vault'],
    },
  },
  {
    name: 'list-tags',
    description: 'List all unique tags (from YAML frontmatter) used across vault notes. Optionally scope to a subdirectory.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name' },
        path:  { type: 'string', description: 'Optional vault-relative path to scope the search' },
      },
      required: ['vault'],
    },
  },
  {
    name: 'search-tag',
    description: 'Find notes that have ALL of the specified tags (YAML frontmatter). Returns vault-relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name' },
        tags:  { type: 'array', items: { type: 'string' }, description: 'Tags that notes must all have' },
        path:  { type: 'string', description: 'Optional vault-relative path to scope the search' },
      },
      required: ['vault', 'tags'],
    },
  },
  {
    name: 'new-notes',
    description: 'List notes created in the last 7 days, or since a provided ISO 8601 timestamp. Returns vault-relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name' },
        since: { type: 'string', description: 'ISO 8601 timestamp; defaults to 7 days ago' },
        path:  { type: 'string', description: 'Optional vault-relative path to scope the search' },
      },
      required: ['vault'],
    },
  },
  {
    name: 'changed-notes',
    description: 'List notes modified in the last 7 days, or since a provided ISO 8601 timestamp. Returns vault-relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Vault name' },
        since: { type: 'string', description: 'ISO 8601 timestamp; defaults to 7 days ago' },
        path:  { type: 'string', description: 'Optional vault-relative path to scope the search' },
      },
      required: ['vault'],
    },
  },
  {
    name: 'list-available-vaults',
    description: 'List all configured Obsidian vaults.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read-note',
    description: 'Read the content of a note. Returns the raw markdown, followed by a second content item with the note\'s ISO 8601 last-modified timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        filename: { type: 'string', description: 'Filename including .md extension' },
        folder:   { type: 'string', description: 'Optional vault-relative folder' },
      },
      required: ['vault', 'filename'],
    },
  },
  {
    name: 'create-note',
    description: 'Create a new note. Fails if the note already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        filename: { type: 'string', description: 'Filename including .md extension' },
        folder:   { type: 'string', description: 'Optional vault-relative folder' },
        content:  { type: 'string', description: 'Markdown content' },
      },
      required: ['vault', 'filename'],
    },
  },
  {
    name: 'edit-note',
    description: 'Edit an existing note by appending, prepending, or replacing its content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:     { type: 'string', description: 'Vault name' },
        filename:  { type: 'string', description: 'Filename including .md extension' },
        folder:    { type: 'string', description: 'Optional vault-relative folder' },
        operation: { type: 'string', enum: ['append', 'prepend', 'replace'], description: 'Edit operation' },
        content:   { type: 'string', description: 'Content to apply' },
      },
      required: ['vault', 'filename', 'operation', 'content'],
    },
  },
  {
    name: 'delete-note',
    description: 'Delete a note, moving it to .trash by default.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:     { type: 'string', description: 'Vault name' },
        filename:  { type: 'string', description: 'Filename including .md extension' },
        folder:    { type: 'string', description: 'Optional vault-relative folder' },
        permanent: { type: 'boolean', description: 'If true, permanently delete instead of trashing' },
      },
      required: ['vault', 'filename'],
    },
  },
  {
    name: 'move-note',
    description: 'Move or rename a note, rewriting all vault-wide wikilinks to the old path.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:       { type: 'string', description: 'Vault name' },
        filename:    { type: 'string', description: 'Source filename including .md extension' },
        folder:      { type: 'string', description: 'Optional source vault-relative folder' },
        newFilename: { type: 'string', description: 'Destination filename including .md extension' },
        newFolder:   { type: 'string', description: 'Optional destination vault-relative folder' },
      },
      required: ['vault', 'filename', 'newFilename'],
    },
  },
  {
    name: 'create-binary-file',
    description: 'Create a new binary file (e.g. an image) from base64-encoded content. Fails if the file already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        filename: { type: 'string', description: 'Filename including extension' },
        folder:   { type: 'string', description: 'Optional vault-relative folder' },
        content:  { type: 'string', description: 'Base64-encoded file content' },
      },
      required: ['vault', 'filename', 'content'],
    },
  },
  {
    name: 'move-binary-file',
    description: 'Move or rename a binary file, rewriting all vault-wide wikilink embeds pointing at the old path.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:       { type: 'string', description: 'Vault name' },
        filename:    { type: 'string', description: 'Source filename including extension' },
        folder:      { type: 'string', description: 'Optional source vault-relative folder' },
        newFilename: { type: 'string', description: 'Destination filename including extension' },
        newFolder:   { type: 'string', description: 'Optional destination vault-relative folder' },
      },
      required: ['vault', 'filename', 'newFilename'],
    },
  },
  {
    name: 'delete-binary-file',
    description: 'Delete a binary file, moving it to .trash by default.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:     { type: 'string', description: 'Vault name' },
        filename:  { type: 'string', description: 'Filename including extension' },
        folder:    { type: 'string', description: 'Optional vault-relative folder' },
        permanent: { type: 'boolean', description: 'If true, permanently delete instead of trashing' },
      },
      required: ['vault', 'filename'],
    },
  },
  {
    name: 'find-backlinks',
    description: 'Find all notes that link to or embed a given note or binary file. Returns sorted vault-relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        filename: { type: 'string', description: 'Target filename including extension' },
        folder:   { type: 'string', description: 'Optional vault-relative folder of the target' },
      },
      required: ['vault', 'filename'],
    },
  },
  {
    name: 'resolve-wikilink',
    description: 'Resolve a wikilink target string (e.g. the "folder/note" portion of [[folder/note#heading|alias]]) to the vault-relative file(s) it points to. Zero results means it doesn\'t resolve; more than one means it\'s ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:  { type: 'string', description: 'Vault name' },
        target: { type: 'string', description: 'Raw wikilink target string, without [[ ]], heading, or alias' },
      },
      required: ['vault', 'target'],
    },
  },
  {
    name: 'create-directory',
    description: 'Create a new directory (and any missing parents) in the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:  { type: 'string', description: 'Vault name' },
        folder: { type: 'string', description: 'Vault-relative path for the new directory' },
      },
      required: ['vault', 'folder'],
    },
  },
  {
    name: 'search-vault',
    description: 'Search vault notes by content, filename, or both (case-insensitive). Content results include line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:      { type: 'string', description: 'Vault name' },
        query:      { type: 'string', description: 'Search query' },
        searchType: { type: 'string', enum: ['content', 'filename', 'both'], description: 'What to search' },
        path:       { type: 'string', description: 'Optional vault-relative path to scope the search' },
      },
      required: ['vault', 'query', 'searchType'],
    },
  },
  {
    name: 'add-tags',
    description: 'Add tags to notes in frontmatter and/or inline body content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        files:    { type: 'array', items: { type: 'string' }, description: 'Vault-relative note paths' },
        tags:     { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        location: { type: 'string', enum: ['frontmatter', 'content', 'both'], description: 'Where to add tags (default: frontmatter)' },
      },
      required: ['vault', 'files', 'tags'],
    },
  },
  {
    name: 'remove-tags',
    description: 'Remove tags from notes in frontmatter and/or inline body content.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        files:    { type: 'array', items: { type: 'string' }, description: 'Vault-relative note paths' },
        tags:     { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        location: { type: 'string', enum: ['frontmatter', 'content', 'both'], description: 'Where to remove tags (default: frontmatter)' },
      },
      required: ['vault', 'files', 'tags'],
    },
  },
  {
    name: 'rename-tag',
    description: 'Rename a tag throughout the entire vault (frontmatter and inline content).',
    inputSchema: {
      type: 'object',
      properties: {
        vault:  { type: 'string', description: 'Vault name' },
        oldTag: { type: 'string', description: 'Tag to rename' },
        newTag: { type: 'string', description: 'New tag name' },
      },
      required: ['vault', 'oldTag', 'newTag'],
    },
  },
  {
    name: 'query-graph',
    description: 'Ask a natural-language question against a vault\'s graphify knowledge graph. Errors clearly if that vault has no graph built.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        question: { type: 'string', description: 'Natural-language question to ask the graph' },
      },
      required: ['vault', 'question'],
    },
  },
];

// ── SSE streams (GET /mcp per session) ────────────────────────────────────

const sseStreams = new Map(); // sessionId → ServerResponse

// ── active HTTP sessions ───────────────────────────────────────────────────

const sessions    = new Set();
const SESSION_TTL = 60_000; // remove sessions that never open a GET /mcp stream

function addSession(sid) {
  if (sessions.size >= 1000) return false;
  sessions.add(sid);
  // If no SSE stream opens within TTL, drop the session
  setTimeout(() => {
    if (!sseStreams.has(sid)) sessions.delete(sid);
  }, SESSION_TTL);
  return true;
}

// ── OAuth static responses ─────────────────────────────────────────────────

const OAUTH_RESOURCE = JSON.stringify({
  resource: BASE_URL,
  authorization_servers: [BASE_URL],
});

const OAUTH_SERVER = JSON.stringify({
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/authorize`,
  token_endpoint:         `${BASE_URL}/token`,
  registration_endpoint:  `${BASE_URL}/register`,
  grant_types_supported:              ['client_credentials', 'authorization_code'],
  token_endpoint_auth_methods_supported: ['none'],
  response_types_supported:           ['code', 'token'],
  scopes_supported:                   [],
});

const TOKEN_RESPONSE = JSON.stringify({
  access_token: 'public',
  token_type:   'Bearer',
  expires_in:   86400,
  scope:        '',
});

// ── HTTP helpers ───────────────────────────────────────────────────────────

function sendSse(res, statusCode, sessionId, msgs) {
  const headers = {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(statusCode, headers);
  for (const m of msgs) {
    res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  }
  res.end();
}

// ── HTTP server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0];
  // Validate session ID as a UUID — all legitimate IDs are created by randomUUID().
  // Non-matching values become '' so sessions.has('') is always false.
  const rawSid = req.headers['mcp-session-id']?.trim() || '';
  const sid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSid)
    ? rawSid : '';
  const safeMethod = req.method?.replace(/[^\w-]/g, '?') ?? 'UNKNOWN';
  const safeUrl    = (url ?? '').replace(/[^\w/.-]/g, '?');
  const safeSid    = sid.slice(0, 8) || 'none';
  log(`${safeMethod} ${safeUrl} sid=${safeSid}`);

  try {
    await route(req, res, url, sid);
  } catch (err) {
    logErr('unhandled:', err);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

async function route(req, res, url, sid) {
  // Reject cross-origin browser requests to defend against DNS-rebinding.
  // Direct tool/CLI calls don't send Origin so this only fires for browsers.
  const origin = req.headers['origin'];
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).hostname; } catch { originHost = null; }
    if (!originHost || !LOOPBACK.has(originHost)) {
      res.writeHead(403); return res.end('forbidden origin');
    }
  }

  // ── OAuth ──────────────────────────────────────────────────────────────
  if (url === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(OAUTH_RESOURCE);
  }
  if (url === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(OAUTH_SERVER);
  }
  if (url === '/authorize' && req.method === 'GET') {
    handleAuthorize(req, res);
    return;
  }
  if (url === '/token' && req.method === 'POST') {
    req.resume(); // drain and discard body
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(TOKEN_RESPONSE);
  }
  if (url === '/register' && req.method === 'POST') {
    req.setEncoding('utf8');
    let body = '';
    for await (const chunk of req) {
      if (body.length + chunk.length > 65536) { req.destroy(); res.writeHead(413); return res.end('request too large'); } // registration payloads are small
      body += chunk;
    }
    let redirect_uris = [];
    try {
      const parsed = JSON.parse(body).redirect_uris;
      if (Array.isArray(parsed)) {
        redirect_uris = parsed.filter(u => {
          try { return LOOPBACK.has(new URL(u).hostname); } catch { return false; }
        });
      }
    } catch {}
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      client_id:              'public-client',
      client_id_issued_at:    Math.floor(Date.now() / 1000),
      redirect_uris,
      grant_types:            ['client_credentials', 'authorization_code'],
      token_endpoint_auth_method: 'none',
    }));
  }

  if (url !== '/mcp') { res.writeHead(404); return res.end('not found'); }

  // ── GET /mcp — notification SSE stream ────────────────────────────────
  if (req.method === 'GET') {
    if (!sid || !sessions.has(sid)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'session not found' }));
    }
    // End any previous SSE response for this session (e.g. reconnect after network blip).
    const prev = sseStreams.get(sid);
    if (prev && !prev.writableEnded) {
      try { prev.end(); } catch {}
    }
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'mcp-session-id': sid,
    });
    res.flushHeaders();
    sseStreams.set(sid, res);
    // On close: remove the stream but keep the session alive so that POST
    // requests (e.g. from a shim that reconnects the SSE stream) still work.
    req.on('close', () => {
      if (sseStreams.get(sid) === res) sseStreams.delete(sid);
    });
    return;
  }

  // ── POST /mcp ──────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('method not allowed');
  }

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    res.writeHead(415); return res.end('content-type must be application/json');
  }

  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    if (body.length + chunk.length > 10 * 1024 * 1024) { // generous ceiling for large tool-call payloads (e.g. base64 binary content)
      logErr(`request body too large at ${body.length + chunk.length} bytes (limit=10MB)`);
      req.destroy(); res.writeHead(413); return res.end('request too large');
    }
    body += chunk;
  }
  if (body.length > 10_000) log(`  → request body: ${body.length} bytes`);

  let msg;
  try { msg = JSON.parse(body); } catch {
    res.writeHead(400); return res.end('invalid json');
  }

  // Clamp msg.id to valid JSON-RPC types (string | number | null) before echoing in responses.
  const msgId = (typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null)
    ? msg.id : null;

  // Log the JSON-RPC method (and tool name for tools/call) so requests are traceable.
  const toolName = msg.method === 'tools/call' ? ` (${msg.params?.name ?? '?'})` : '';
  log(`  → ${msg.method ?? '?'}${toolName} sid=${sid.slice(0, 8) || 'none'}`);

  // initialize → new session, no forwarding needed
  if (msg.method === 'initialize') {
    const newSid = randomUUID();
    if (!addSession(newSid)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msgId, error: { code: -32603, message: 'session table full' } }));
    }
    return sendSse(res, 200, newSid, [{
      jsonrpc: '2.0',
      id: msgId,
      result: SERVER_CAPS,
    }]);
  }

  // All other requests need a valid session — 404 signals the shim to re-initialize.
  if (!sid || !sessions.has(sid)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'session not found' }));
  }

  // notifications (no id member per JSON-RPC 2.0) → 202, don't forward
  // Note: id:null is technically a malformed request, not a notification, but
  // no legitimate client sends one, so it's treated the same way.
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202);
    return res.end();
  }

  // base-protocol liveness check — capability-independent, so it's answered
  // unconditionally rather than falling through to the unknown-method error below.
  if (msg.method === 'ping') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {} }]);
  }

  // static responses for methods this bridge doesn't support server-side
  if (msg.method === 'resources/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { resources: [] } }]);
  }
  if (msg.method === 'prompts/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { prompts: [] } }]);
  }
  if (msg.method === 'tools/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { tools: BRIDGE_TOOLS } }]);
  }

  // list-available-vaults is answered directly from the configured vaults map
  if (msg.method === 'tools/call' && msg.params?.name === 'list-available-vaults') {
    const names = Object.keys(VAULTS).sort();
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
      content: [{ type: 'text', text: `Available vaults:\n${names.map(n => `  - ${n}`).join('\n')}` }],
    } }]);
  }

  // path access control for tool calls
  if (msg.method === 'tools/call') {
    const denied = checkAccess(msg.params?.name, msg.params?.arguments ?? {});
    if (denied) {
      const safeName = String(msg.params?.name ?? '').replace(/[\r\n]/g, '?');
      log(`DENY ${safeName}: ${denied}`);
      return sendSse(res, 200, sid, [{
        jsonrpc: '2.0',
        id: msgId,
        result: { content: [{ type: 'text', text: denied }], isError: true },
      }]);
    }
  }

  // ── bridge-native tool handlers ──────────────────────────────────────────
  if (msg.method === 'tools/call' && msg.params?.name === 'list-notes') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Unknown vault: ${args.vault}` }], isError: true,
      } }]);
    }
    const relScope = args.path ? normPath(args.path) : null;
    if (relScope && _isDenied(vault.denyPaths, relScope)) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: 'Access denied' }], isError: true,
      } }]);
    }
    const scopePath = relScope ? path.join(vault.path, relScope) : vault.path;
    try {
      const notes = [];
      await libWalkVault(scopePath, async (filePath) => {
        const rel = path.relative(vault.path, filePath);
        if (_isDenied(vault.denyPaths, rel)) return;
        notes.push(rel);
      });
      notes.sort();
      const lines = [];
      for (const rel of notes) {
        const stat = await fs.stat(path.join(vault.path, rel));
        lines.push(`${rel}\t${stat.mtime.toISOString()}`);
      }
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No notes found' }],
      } }]);
    } catch (err) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Error listing notes: ${err.message.replaceAll(vault.path + '/', '')}` }], isError: true,
      } }]);
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'list-tags') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Unknown vault: ${args.vault}` }], isError: true,
      } }]);
    }
    const relScope = args.path ? normPath(args.path) : null;
    if (relScope && _isDenied(vault.denyPaths, relScope)) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: 'Access denied' }], isError: true,
      } }]);
    }
    const scopePath = relScope ? path.join(vault.path, relScope) : vault.path;
    try {
      const tags = new Set();
      await libWalkVault(scopePath, async (filePath) => {
        const rel = path.relative(vault.path, filePath);
        if (_isDenied(vault.denyPaths, rel)) return;
        const content = await fs.readFile(filePath, 'utf8');
        for (const tag of fmParseTags(content)) tags.add(tag);
      });
      const sorted = [...tags].sort();
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: sorted.length ? sorted.join('\n') : 'No tags found' }],
      } }]);
    } catch (err) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Error listing tags: ${err.message.replaceAll(vault.path + '/', '')}` }], isError: true,
      } }]);
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'search-tag') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Unknown vault: ${args.vault}` }], isError: true,
      } }]);
    }
    const queryTags = Array.isArray(args.tags) ? args.tags.map(t => String(t).toLowerCase()) : [];
    if (!queryTags.length) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: 'No tags specified' }], isError: true,
      } }]);
    }
    const relScope = args.path ? normPath(args.path) : null;
    if (relScope && _isDenied(vault.denyPaths, relScope)) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: 'Access denied' }], isError: true,
      } }]);
    }
    const scopePath = relScope ? path.join(vault.path, relScope) : vault.path;
    try {
      const matches = [];
      await libWalkVault(scopePath, async (filePath) => {
        const rel = path.relative(vault.path, filePath);
        if (_isDenied(vault.denyPaths, rel)) return;
        const content = await fs.readFile(filePath, 'utf8');
        const noteTags = fmParseTags(content).map(t => t.toLowerCase());
        if (queryTags.every(t => noteTags.includes(t))) matches.push(rel);
      });
      matches.sort();
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: matches.length ? matches.join('\n') : 'No notes found' }],
      } }]);
    } catch (err) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Error searching tags: ${err.message.replaceAll(vault.path + '/', '')}` }], isError: true,
      } }]);
    }
  }

  if (msg.method === 'tools/call' && (msg.params?.name === 'new-notes' || msg.params?.name === 'changed-notes')) {
    const toolName = msg.params.name;
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Unknown vault: ${args.vault}` }], isError: true,
      } }]);
    }
    let cutoffMs;
    if (args.since !== undefined) {
      cutoffMs = new Date(args.since).getTime();
      if (Number.isNaN(cutoffMs)) {
        return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
          content: [{ type: 'text', text: `Invalid since timestamp: ${args.since}` }], isError: true,
        } }]);
      }
    } else {
      cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    }
    const relScope = args.path ? normPath(args.path) : null;
    if (relScope && _isDenied(vault.denyPaths, relScope)) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: 'Access denied' }], isError: true,
      } }]);
    }
    const scopePath = relScope ? path.join(vault.path, relScope) : vault.path;
    try {
      const matches = [];
      await libWalkVault(scopePath, async (filePath) => {
        const rel = path.relative(vault.path, filePath);
        if (_isDenied(vault.denyPaths, rel)) return;
        const stat = await fs.stat(filePath);
        const timeMs = toolName === 'new-notes' ? stat.birthtimeMs : stat.mtimeMs;
        if (timeMs >= cutoffMs) matches.push(rel);
      });
      matches.sort();
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: matches.length ? matches.join('\n') : 'No notes found' }],
      } }]);
    } catch (err) {
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [{ type: 'text', text: `Error: ${err.message.replaceAll(vault.path + '/', '')}` }], isError: true,
      } }]);
    }
  }

  // ── Phase 2 bridge-native handlers ──────────────────────────────────────

  if (msg.method === 'tools/call' && msg.params?.name === 'read-note') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    try {
      const absPath = path.join(vault.path, relPath);
      const content = await libReadNote(absPath);
      const stat = await fs.stat(absPath);
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [
          { type: 'text', text: content },
          { type: 'text', text: `Last-Modified: ${stat.mtime.toISOString()}` },
        ],
      } }]);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'create-note') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    const absPath = path.join(vault.path, relPath);
    try {
      await fs.access(absPath);
      return toolErr(res, sid, msgId, `Note already exists: ${relPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
    try {
      await libWriteNote(absPath, args.content ?? '');
      return toolOk(res, sid, msgId, `Created: ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'edit-note') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    const op = args.operation;
    if (!['append', 'prepend', 'replace'].includes(op))
      return toolErr(res, sid, msgId, `Invalid operation: ${op}`);
    const absPath = path.join(vault.path, relPath);
    try {
      if (op === 'replace') {
        await libWriteNote(absPath, args.content ?? '');
      } else {
        const existing = await libReadNote(absPath);
        const newContent = args.content ?? '';
        const updated = op === 'append' ? existing + newContent : newContent + existing;
        await libWriteNote(absPath, updated);
      }
      return toolOk(res, sid, msgId, `Edited (${op}): ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'delete-note') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    try {
      const permanent = args.permanent === true;
      await libDeleteNote(path.join(vault.path, relPath), permanent, vault.path);
      return toolOk(res, sid, msgId, permanent ? `Deleted: ${relPath}` : `Moved to trash: ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'move-note') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const srcRel = normPath(args.folder, args.filename);
    const dstRel = normPath(args.newFolder, args.newFilename);
    if (!srcRel) return toolErr(res, sid, msgId, 'filename is required');
    if (!dstRel) return toolErr(res, sid, msgId, 'newFilename is required');
    if (_isDenied(vault.denyPaths, srcRel)) return toolErr(res, sid, msgId, 'Access denied: source is restricted');
    if (_isDenied(vault.denyPaths, dstRel)) return toolErr(res, sid, msgId, 'Access denied: destination is restricted');
    try {
      await libMoveNote(vault.path, path.join(vault.path, srcRel), path.join(vault.path, dstRel), vault.denyPaths);
      return toolOk(res, sid, msgId, `Moved: ${srcRel} → ${dstRel}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'create-binary-file') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (relPath.toLowerCase().endsWith('.md')) return toolErr(res, sid, msgId, 'Use create-note for .md files');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    if (typeof args.content !== 'string') return toolErr(res, sid, msgId, 'content must be a base64-encoded string');
    const b64Body = args.content.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64Body) || b64Body.length % 4 !== 0) {
      return toolErr(res, sid, msgId, 'content is not valid base64');
    }
    const absPath = path.join(vault.path, relPath);
    try {
      await fs.access(absPath);
      return toolErr(res, sid, msgId, `File already exists: ${relPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
    try {
      const buffer = Buffer.from(args.content, 'base64');
      await libWriteBinaryFile(absPath, buffer);
      return toolOk(res, sid, msgId, `Created: ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'delete-binary-file') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (relPath.toLowerCase().endsWith('.md')) return toolErr(res, sid, msgId, 'Use delete-note for .md files');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    try {
      const permanent = args.permanent === true;
      await libDeleteBinaryFile(path.join(vault.path, relPath), permanent, vault.path);
      return toolOk(res, sid, msgId, permanent ? `Deleted: ${relPath}` : `Moved to trash: ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'move-binary-file') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const srcRel = normPath(args.folder, args.filename);
    const dstRel = normPath(args.newFolder, args.newFilename);
    if (!srcRel) return toolErr(res, sid, msgId, 'filename is required');
    if (!dstRel) return toolErr(res, sid, msgId, 'newFilename is required');
    if (srcRel.toLowerCase().endsWith('.md') || dstRel.toLowerCase().endsWith('.md'))
      return toolErr(res, sid, msgId, 'Use move-note for .md files');
    if (_isDenied(vault.denyPaths, srcRel)) return toolErr(res, sid, msgId, 'Access denied: source is restricted');
    if (_isDenied(vault.denyPaths, dstRel)) return toolErr(res, sid, msgId, 'Access denied: destination is restricted');
    try {
      await libMoveBinaryFile(vault.path, path.join(vault.path, srcRel), path.join(vault.path, dstRel), vault.denyPaths);
      return toolOk(res, sid, msgId, `Moved: ${srcRel} → ${dstRel}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'find-backlinks') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    try {
      const results = await libFindBacklinks(vault.path, relPath, vault.denyPaths);
      return toolOk(res, sid, msgId, results.length ? results.join('\n') : 'No backlinks found');
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'resolve-wikilink') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    if (!args.target) return toolErr(res, sid, msgId, 'target is required');
    if (_isDenied(vault.denyPaths, normPath(args.target))) return toolErr(res, sid, msgId, 'Access denied');
    try {
      const results = await libResolveWikilink(vault.path, args.target, vault.denyPaths);
      return toolOk(res, sid, msgId, results.length ? results.join('\n') : `No file resolves wikilink target: ${args.target}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'query-graph') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    if (!args.question) return toolErr(res, sid, msgId, 'question is required');
    try {
      await fs.access(path.join(vault.path, 'graphify-out', 'graph.json'));
    } catch {
      return toolErr(res, sid, msgId, 'graphify-out/graph.json not found. Run graphify --obsidian against this vault.');
    }
    try {
      const output = await runGraphifyQuery(vault.path, args.question);
      return toolOk(res, sid, msgId, output);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'create-directory') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder);
    if (!relPath) return toolErr(res, sid, msgId, 'folder is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    try {
      await fs.mkdir(path.join(vault.path, relPath), { recursive: true });
      return toolOk(res, sid, msgId, `Created directory: ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'search-vault') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    if (!args.query) return toolErr(res, sid, msgId, 'query is required');
    const sType = args.searchType || 'content';
    if (!['content', 'filename', 'both'].includes(sType))
      return toolErr(res, sid, msgId, `Invalid searchType: ${sType}`);
    const relScope = args.path ? normPath(args.path) : null;
    if (relScope && _isDenied(vault.denyPaths, relScope)) return toolErr(res, sid, msgId, 'Access denied');
    const scopeDir = relScope ? path.join(vault.path, relScope) : vault.path;
    try {
      const lines = [];
      if (sType === 'content' || sType === 'both') {
        const results = await libSearchContent(vault.path, args.query, scopeDir, vault.denyPaths);
        for (const { path: p, matches } of results)
          for (const { line, text } of matches)
            lines.push(`${p}:${line}: ${text.trim()}`);
      }
      if (sType === 'filename' || sType === 'both') {
        const results = await libSearchFilename(vault.path, args.query, scopeDir, vault.denyPaths);
        for (const p of results) lines.push(p);
      }
      return toolOk(res, sid, msgId, lines.length ? lines.join('\n') : 'No results found');
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && (msg.params?.name === 'add-tags' || msg.params?.name === 'remove-tags')) {
    const isAdd = msg.params.name === 'add-tags';
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const files = Array.isArray(args.files) ? args.files : [];
    const tags  = Array.isArray(args.tags)  ? args.tags  : [];
    if (!files.length) return toolErr(res, sid, msgId, 'files array is required');
    if (!tags.length)  return toolErr(res, sid, msgId, 'tags array is required');
    const location = args.location || 'frontmatter';
    const updated = [], skipped = [];
    for (const file of files) {
      const relPath = normPath(file);
      if (_isDenied(vault.denyPaths, relPath)) { skipped.push(`${relPath} (access denied)`); continue; }
      try {
        let content = await libReadNote(path.join(vault.path, relPath));
        const original = content;
        if (location === 'frontmatter' || location === 'both') {
          content = isAdd ? fmAddTags(content, tags) : fmRemoveTags(content, tags);
        }
        if (location === 'content' || location === 'both') {
          if (isAdd) {
            const body = content.trimEnd();
            const boundary = `(?![a-zA-Z0-9_/\\-])`;
            const toAdd = tags.filter(t => !new RegExp(`(?:^|[ \\t])#${escRe(t)}${boundary}`, 'm').test(body));
            if (toAdd.length) content = body + '\n' + toAdd.map(t => `#${t}`).join(' ') + '\n';
          } else {
            for (const tag of tags) {
              const esc = escRe(tag);
              const boundary = `(?![a-zA-Z0-9_/\\-])`;
              // Remove at start-of-line (consuming trailing whitespace so no blank gap)
              content = content.replace(new RegExp(`^#${esc}${boundary}[ \\t]*`, 'gm'), '');
              // Remove inline (preceded by whitespace — drop the space too)
              content = content.replace(new RegExp(`[ \\t]#${esc}${boundary}`, 'gm'), '');
            }
          }
        }
        if (content !== original) {
          await libWriteNote(path.join(vault.path, relPath), content);
          updated.push(relPath);
        }
      } catch (err) {
        skipped.push(`${relPath} (${err.message.replaceAll(vault.path + '/', '')})`);
      }
    }
    const parts = [];
    if (updated.length) parts.push(`Updated ${updated.length} note(s): ${updated.join(', ')}`);
    if (skipped.length) parts.push(`Skipped: ${skipped.join(', ')}`);
    return toolOk(res, sid, msgId, parts.join('\n') || 'No changes needed');
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'rename-tag') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    if (!args.oldTag) return toolErr(res, sid, msgId, 'oldTag is required');
    if (!args.newTag) return toolErr(res, sid, msgId, 'newTag is required');
    try {
      let count = 0;
      await libWalkVault(vault.path, async filePath => {
        const rel = path.relative(vault.path, filePath);
        if (_isDenied(vault.denyPaths, rel)) return;
        let content;
        try { content = await libReadNote(filePath); } catch { return; }
        const updated = fmRenameTag(content, args.oldTag, args.newTag);
        if (updated !== content) {
          try { await libWriteNote(filePath, updated); count++; } catch {}
        }
      });
      return toolOk(res, sid, msgId, `Renamed tag '${args.oldTag}' → '${args.newTag}' in ${count} note(s)`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  // Every named tool has its own handler above and returns before reaching here.
  if (msg.method === 'tools/call') {
    return toolErr(res, sid, msgId, `Unknown tool: ${msg.params?.name}`);
  }
  return sendSse(res, 200, sid, [{
    jsonrpc: '2.0',
    id: msgId,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  }]);
}

// Runs `graphify query "<question>"` in the given vault's directory. Array-form spawn
// args (no shell) so the question text can never be interpreted as shell syntax or reach
// graphify as anything other than a single literal argument — graphify's own CLI reads
// sys.argv[2] unconditionally as the question (it's a hand-rolled argv parser, not
// argparse, with no '--' end-of-options handling), so there's no separate flag-smuggling
// risk to guard against here; adding a '--' would instead shift the question to the wrong
// argv position and break every real query. Killed (SIGTERM, then SIGKILL after a short
// grace period if still alive) if it runs longer than GRAPHIFY_QUERY_TIMEOUT_MS, so a hung
// query can't hold a request open forever or leak an orphaned process if it ignores SIGTERM.
function runGraphifyQuery(vaultPath, question) {
  return new Promise((resolve, reject) => {
    const child = spawn('graphify', ['query', question], { cwd: vaultPath });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
      reject(new Error(`graphify query timed out after ${GRAPHIFY_QUERY_TIMEOUT_MS}ms`));
    }, GRAPHIFY_QUERY_TIMEOUT_MS);

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? 'graphify command not found on PATH' : err.message));
    });

    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`graphify query exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function handleAuthorize(req, res) {
  req.resume(); // GET requests have no body, but drain anyway for keep-alive hygiene
  const qs          = new URL(req.url, BASE_URL).searchParams;
  const redirectUri = qs.get('redirect_uri');
  const state       = qs.get('state');
  if (!redirectUri) { res.writeHead(400); return res.end('missing redirect_uri'); }

  let dest;
  try { dest = new URL(redirectUri); } catch {
    res.writeHead(400); return res.end('invalid redirect_uri');
  }

  // Only redirect to loopback — the only legitimate client is Claude Code,
  // which always uses a local callback server.
  if (!LOOPBACK.has(dest.hostname)) {
    res.writeHead(400); return res.end('redirect_uri must target localhost');
  }

  // PKCE is not enforced; code is a fixed placeholder since token exchange is also a no-op.
  dest.searchParams.set('code', 'public-auth-code');
  if (state) dest.searchParams.set('state', state.slice(0, 512));

  res.writeHead(302, { Location: dest.toString() });
  res.end();
}

// ── start ──────────────────────────────────────────────────────────────────

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`obsidian-mcp bridge listening on 127.0.0.1:${LISTEN_PORT}`);
});
