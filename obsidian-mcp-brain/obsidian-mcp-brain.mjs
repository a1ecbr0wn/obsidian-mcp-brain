#!/usr/bin/env node
/**
 * MCP server exposing one or more Obsidian vaults to remote MCP clients over HTTP.
 *   - Implements MCP Streamable HTTP transport (2024-11-05 spec)
 *   - Provides the OAuth 2.0 discovery endpoints Claude Code requires
 *   - Reads and writes vault files directly, with no child process dependency
 *
 * Usage: node obsidian-mcp-brain.mjs
 * Configuration is read from a JSON file — see loadConfig() below for its shape,
 * location, and validation. CONFIG_PATH is the only environment variable read.
 */

import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync, createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { normPath, isDenied as _isDenied, checkAccess as _checkAccess, compileBinaryPatterns, isBinaryReadDenied, checkBinaryMove } from './lib/access.mjs';
import { mimeTypeFor } from './lib/mime.mjs';
import {
  UploadSlots,
  normalizeAddress,
  compileTrustedProxies,
  callerAddress,
  checkStagingDir,
  checkStagingDirOwner,
  defaultUploadTempDir,
  resolveDestination,
  sweepStaging,
  stagingFileName,
} from './lib/uploads.mjs';
import { parseTags as fmParseTags, addTags as fmAddTags, removeTags as fmRemoveTags, renameTag as fmRenameTag, setFrontmatterField, removeFrontmatterField } from './lib/frontmatter.mjs';
import { escRe } from './lib/utils.mjs';
import { replaceSection, deleteSection, toggleCheckbox } from './lib/sections.mjs';
import { assertUnmodified, formatMtime } from './lib/preconditions.mjs';
import { fetchToBuffer } from './lib/fetch.mjs';
import {
  walkVault as libWalkVault,
  readNote as libReadNote,
  writeNote as libWriteNote,
  deleteNote as libDeleteNote,
  moveNote as libMoveNote,
  searchContent as libSearchContent,
  searchFilename as libSearchFilename,
  readBinaryFile as libReadBinaryFile,
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
//     "listenHost": "127.0.0.1",
//     "mcpBaseUrl": "https://host:4001",
//     "denyPaths": ["private"],
//     "graphifyQueryTimeoutMs": 60000,
//     "fetchMaxBytes": 10485760,
//     "fetchTimeoutMs": 30000,
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

/**
 * When any denyBinaryPaths are set, `.trash` is protected too. A non-permanent
 * delete-binary-file moves a file there, and without this a protected file could be
 * deleted to the trash and then read, or moved out, from a path no pattern covers.
 * @param {string[]} patterns - A vault's merged denyBinaryPaths.
 * @returns {string[]} The same list plus `.trash`, or [] if nothing is protected.
 */
const withTrash = (patterns) => (patterns.length ? [...patterns, '.trash'] : patterns);

/**
 * Loads and validates the configuration file from the given path.
 * Config fields: listenPort (default 3002), listenHost (default "127.0.0.1"),
 * mcpBaseUrl (required), denyPaths (default []), denyBinaryPaths (default [], wildcard
 * patterns whose binary files read-binary-file refuses to return), graphifyQueryTimeoutMs
 * (default 60000), fetchMaxBytes (default 10MB), fetchTimeoutMs (default 30000),
 * readMaxBytes (default 10MB), uploadMaxBytes (default 50MB), uploadTtlSeconds (default 300),
 * uploadTempDir (default: obsidian-mcp-uploads-<uid> under the OS temp dir for per-user isolation;
 * where uploads are staged, never inside a vault), trustedProxies (default [], addresses or CIDR
 * ranges of reverse proxies whose X-Forwarded-For is believed), and vaults (required). Each vault
 * may add its own denyPaths and denyBinaryPaths on top of the global lists. When any denyBinaryPaths
 * are configured, '.trash' is automatically added to protect against reads/moves of deleted files.
 * listenHost must be a non-empty string (e.g. "127.0.0.1", "0.0.0.0", or "::1").
 * Exits the process on validation failure.
 * @param {string} configPath - Path to the configuration JSON file.
 * @returns {object} Configuration object with validated and parsed fields.
 */
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
    logErr(`Config file at ${configPath} must set "mcpBaseUrl" to the public HTTPS base URL of this server (e.g. https://hostname:4001)`);
    process.exit(1);
  }

  const listenPort = parseInt(config.listenPort ?? 3002, 10);
  if (Number.isNaN(listenPort) || listenPort < 1 || listenPort > 65535) {
    logErr(`Config file at ${configPath}: "listenPort" must be a valid port number (1-65535)`);
    process.exit(1);
  }

  const listenHost = config.listenHost === undefined ? '127.0.0.1' : config.listenHost;
  if (typeof listenHost !== 'string' || !listenHost.trim()) {
    logErr(`Config file at ${configPath}: "listenHost" must be a non-empty string (e.g. "127.0.0.1" or "0.0.0.0")`);
    process.exit(1);
  }

  const graphifyQueryTimeoutMs = parseInt(config.graphifyQueryTimeoutMs ?? 60000, 10);
  if (Number.isNaN(graphifyQueryTimeoutMs) || graphifyQueryTimeoutMs < 1) {
    logErr(`Config file at ${configPath}: "graphifyQueryTimeoutMs" must be a positive number`);
    process.exit(1);
  }

  const fetchMaxBytes = parseInt(config.fetchMaxBytes ?? 10 * 1024 * 1024, 10);
  if (Number.isNaN(fetchMaxBytes) || fetchMaxBytes < 1) {
    logErr(`Config file at ${configPath}: "fetchMaxBytes" must be a positive number`);
    process.exit(1);
  }

  const fetchTimeoutMs = parseInt(config.fetchTimeoutMs ?? 30000, 10);
  if (Number.isNaN(fetchTimeoutMs) || fetchTimeoutMs < 1) {
    logErr(`Config file at ${configPath}: "fetchTimeoutMs" must be a positive number`);
    process.exit(1);
  }

  const readMaxBytes = parseInt(config.readMaxBytes ?? 10 * 1024 * 1024, 10);
  if (Number.isNaN(readMaxBytes) || readMaxBytes < 1) {
    logErr(`Config file at ${configPath}: "readMaxBytes" must be a positive number`);
    process.exit(1);
  }

  const uploadMaxBytes = parseInt(config.uploadMaxBytes ?? 50 * 1024 * 1024, 10);
  if (Number.isNaN(uploadMaxBytes) || uploadMaxBytes < 1) {
    logErr(`Config file at ${configPath}: "uploadMaxBytes" must be a positive number`);
    process.exit(1);
  }

  const uploadTtlSeconds = parseInt(config.uploadTtlSeconds ?? 300, 10);
  if (Number.isNaN(uploadTtlSeconds) || uploadTtlSeconds < 1) {
    logErr(`Config file at ${configPath}: "uploadTtlSeconds" must be a positive number`);
    process.exit(1);
  }

  const uploadTempDirIsDefault = config.uploadTempDir === undefined;
  const uploadTempDirRaw = config.uploadTempDir ?? defaultUploadTempDir();
  if (typeof uploadTempDirRaw !== 'string' || !uploadTempDirRaw.trim()) {
    logErr(`Config file at ${configPath}: "uploadTempDir" must be a non-empty string`);
    process.exit(1);
  }
  const uploadTempDir = uploadTempDirRaw.trim();

  if (config.trustedProxies !== undefined
      && (!Array.isArray(config.trustedProxies) || config.trustedProxies.some(p => typeof p !== 'string'))) {
    logErr(`Config file at ${configPath}: "trustedProxies" must be an array of strings`);
    process.exit(1);
  }
  let trustedProxies;
  try {
    trustedProxies = compileTrustedProxies(config.trustedProxies ?? []);
  } catch (err) {
    logErr(`Config file at ${configPath}: "trustedProxies": ${err.message}`);
    process.exit(1);
  }

  const globalDenyPaths = normDenyPaths(config.denyPaths, configPath, 'denyPaths');
  const globalDenyBinaryPaths = normDenyPaths(config.denyBinaryPaths, configPath, 'denyBinaryPaths');

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
      denyBinaryPaths: compileBinaryPatterns(withTrash([
        ...globalDenyBinaryPaths,
        ...normDenyPaths(entry.denyBinaryPaths, configPath, `vaults.${name}.denyBinaryPaths`),
      ])),
    };
  }

  const stagingProblem = checkStagingDir(uploadTempDir, Object.values(vaults).map(v => v.path));
  if (stagingProblem) {
    logErr(`Config file at ${configPath}: "uploadTempDir" ${stagingProblem}`);
    process.exit(1);
  }

  return {
    listenPort,
    listenHost: listenHost.trim(),
    baseUrl: config.mcpBaseUrl,
    graphifyQueryTimeoutMs,
    fetchMaxBytes,
    fetchTimeoutMs,
    readMaxBytes,
    uploadMaxBytes,
    uploadTtlSeconds,
    uploadTempDir: path.resolve(uploadTempDir),
    uploadTempDirIsDefault,
    trustedProxies,
    vaults,
  };
}

const {
  listenPort: LISTEN_PORT,
  listenHost: LISTEN_HOST,
  baseUrl: BASE_URL,
  graphifyQueryTimeoutMs: GRAPHIFY_QUERY_TIMEOUT_MS,
  fetchMaxBytes: FETCH_MAX_BYTES,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  readMaxBytes: READ_MAX_BYTES,
  uploadMaxBytes: UPLOAD_MAX_BYTES,
  uploadTtlSeconds: UPLOAD_TTL_SECONDS,
  uploadTempDir: CONFIGURED_UPLOAD_TEMP_DIR,
  uploadTempDirIsDefault: UPLOAD_TEMP_DIR_IS_DEFAULT,
  trustedProxies: TRUSTED_PROXIES,
  vaults: VAULTS,
} = loadConfig(CONFIG_PATH);

// Where uploads are staged. Starts as the configured path; prepareStagingDir() replaces it with
// the folder's real path once that has been checked, so a symbolic link re-pointed afterwards
// cannot move staging somewhere that was never checked.
let UPLOAD_TEMP_DIR = CONFIGURED_UPLOAD_TEMP_DIR;

// ── Path access control ────────────────────────────────────────────────────

// Resolves args.vault's effective (global + per-vault) deny list before calling
// the shared, vault-agnostic checkAccess/isDenied functions. An unrecognised
// vault name falls back to an empty deny list here — the request fails
// downstream anyway ("Unknown vault"), so there's nothing extra to protect.
const checkAccess = (toolName, args) => _checkAccess(VAULTS[args.vault]?.denyPaths ?? [], toolName, args);

const toolOk  = (res, sid, id, text) => sendSse(res, 200, sid, [{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }]);
const toolErr = (res, sid, id, text) => sendSse(res, 200, sid, [{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }]);
// A frontmatter field name must be a simple key with no YAML/regex-structural
// characters — otherwise a caller-supplied field could splice extra lines
// (including a spurious `---`) into the raw frontmatter block on write.
const FIELD_NAME_RE = /^[A-Za-z0-9_-]+$/;

// Static initialize response — every tool is native, so there's no child
// capabilities negotiation to wait on.
const SERVER_CAPS = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'obsidian-mcp-brain', version: '1.0.0' },
};

// ── Native tools ────────────────────────────────────────────────────


const TOOLS = [
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
    name: 'search-tags',
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
    name: 'list-vaults',
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
    description: 'Edit an existing note by appending, prepending, replacing its content, replacing or deleting the content under a heading, or toggling a checkbox.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Filename including .md extension' },
        folder:        { type: 'string', description: 'Optional vault-relative folder' },
        operation:     { type: 'string', enum: ['append', 'prepend', 'replace', 'replace-section', 'delete-section', 'toggle-checkbox'], description: 'Edit operation' },
        content:       { type: 'string', description: 'Content to apply (append/prepend/replace/replace-section)' },
        heading:       { type: 'string', description: 'Exact heading text to match (replace-section/delete-section only)' },
        taskText:      { type: 'string', description: 'Exact checkbox text after the [ ]/[x] marker (toggle-checkbox only)' },
        checked:       { type: 'boolean', description: 'Explicit checkbox state (toggle-checkbox only); omit to flip the current state' },
        occurrence:    { type: 'integer', description: 'Disambiguates when heading/taskText matches more than once (1-based)' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the edit is refused if the note has changed since' },
      },
      required: ['vault', 'filename', 'operation'],
    },
  },
  {
    name: 'delete-note',
    description: 'Delete a note, moving it to .trash by default.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Filename including .md extension' },
        folder:        { type: 'string', description: 'Optional vault-relative folder' },
        permanent:     { type: 'boolean', description: 'If true, permanently delete instead of trashing' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the delete is refused if the note has changed since' },
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
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Source filename including .md extension' },
        folder:        { type: 'string', description: 'Optional source vault-relative folder' },
        newFilename:   { type: 'string', description: 'Destination filename including .md extension' },
        newFolder:     { type: 'string', description: 'Optional destination vault-relative folder' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the move is refused if the source note has changed since' },
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
    name: 'fetch-binary-file',
    description: 'Create a new binary file by downloading a URL server-side, so the client only needs to send a URL rather than the full file content. Fails if the file already exists. The URL must be http(s) and resolve to a public address.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:     { type: 'string', description: 'Vault name' },
        filename:  { type: 'string', description: 'Filename including extension' },
        folder:    { type: 'string', description: 'Optional vault-relative folder' },
        url:       { type: 'string', description: 'http(s) URL to download' },
        maxBytes:  { type: 'integer', description: 'Optional override for the maximum response size in bytes (default from server config)' },
        timeoutMs: { type: 'integer', description: 'Optional override for the request timeout in milliseconds (default from server config)' },
      },
      required: ['vault', 'filename', 'url'],
    },
  },
  {
    name: 'upload-binary-file',
    description: 'Reserve a one-time URL for uploading a binary file (a PDF, an image) to the vault without sending its contents through the model. '
      + 'Give the destination, the file\'s size in bytes and its SHA-256, both computed with a tool such as `wc -c` and `sha256sum`, never by hand. '
      + 'The result is a URL and a ready-to-run command: `curl --fail-with-body -sS -T <file> <url>`. '
      + 'The URL works for ONE request only, for a few minutes, and only from the machine that called this tool; if the upload fails for any reason, call this tool again for a new URL. '
      + 'The server checks the received file against the declared size and hash and puts it in the vault only if both match, otherwise it discards it. '
      + 'Fails if the destination already exists. '
      + 'If the upload-binary-file skill is installed, use its upload-binary-file.sh script, which does the hashing and the curl call for you.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        filename: { type: 'string', description: 'Filename including extension' },
        folder:   { type: 'string', description: 'Optional vault-relative folder' },
        size:     { type: 'integer', description: 'Size of the file in bytes (for example from `wc -c`)' },
        sha256:   { type: 'string', description: 'SHA-256 of the file as 64 hexadecimal characters (for example from `sha256sum`)' },
      },
      required: ['vault', 'filename', 'size', 'sha256'],
    },
  },
  {
    name: 'read-binary-file',
    description: 'Read a binary file (e.g. a PDF) from the vault and return it to the client as an embedded base64 resource. Fails if the file is larger than the configured limit or its path is read-protected. A large file (several MB) that has not been read recently can make the client report a timeout such as "The operation timed out" on the first call even though the server is still working and the next call is fast: if that happens, call the tool again, up to twice, and only then tell the user it failed.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:    { type: 'string', description: 'Vault name' },
        filename: { type: 'string', description: 'Filename including extension' },
        folder:   { type: 'string', description: 'Optional vault-relative folder' },
      },
      required: ['vault', 'filename'],
    },
  },
  {
    name: 'move-binary-file',
    description: 'Move or rename a binary file, rewriting all vault-wide wikilink embeds pointing at the old path.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Source filename including extension' },
        folder:        { type: 'string', description: 'Optional source vault-relative folder' },
        newFilename:   { type: 'string', description: 'Destination filename including extension' },
        newFolder:     { type: 'string', description: 'Optional destination vault-relative folder' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the move is refused if the source file has changed since' },
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
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Filename including extension' },
        folder:        { type: 'string', description: 'Optional vault-relative folder' },
        permanent:     { type: 'boolean', description: 'If true, permanently delete instead of trashing' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the delete is refused if the file has changed since' },
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
    name: 'create-folder',
    description: 'Create a new folder (and any missing parents) in the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:  { type: 'string', description: 'Vault name' },
        folder: { type: 'string', description: 'Vault-relative path for the new folder' },
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
        vault:         { type: 'string', description: 'Vault name' },
        files:         { type: 'array', items: { type: 'string' }, description: 'Vault-relative note paths' },
        tags:          { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        location:      { type: 'string', enum: ['frontmatter', 'content', 'both'], description: 'Where to add tags (default: frontmatter)' },
        expectedMtime: { type: 'object', description: 'Optional map of vault-relative path to ISO 8601 mtime; checked for every listed file before any file is written (all-or-nothing)' },
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
        vault:         { type: 'string', description: 'Vault name' },
        files:         { type: 'array', items: { type: 'string' }, description: 'Vault-relative note paths' },
        tags:          { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        location:      { type: 'string', enum: ['frontmatter', 'content', 'both'], description: 'Where to remove tags (default: frontmatter)' },
        expectedMtime: { type: 'object', description: 'Optional map of vault-relative path to ISO 8601 mtime; checked for every listed file before any file is written (all-or-nothing)' },
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
    name: 'set-frontmatter-field',
    description: 'Set a single frontmatter field (not tags) to a scalar value, creating the frontmatter block or the field if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Filename including .md extension' },
        folder:        { type: 'string', description: 'Optional vault-relative folder' },
        field:         { type: 'string', description: 'Frontmatter key (any field except tags)' },
        value:         { description: 'Scalar value to set (string, number, or boolean)' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the write is refused if the note has changed since' },
      },
      required: ['vault', 'filename', 'field', 'value'],
    },
  },
  {
    name: 'remove-frontmatter-field',
    description: 'Remove a single frontmatter field (not tags) entirely. No-op if the field or frontmatter block doesn\'t exist.',
    inputSchema: {
      type: 'object',
      properties: {
        vault:         { type: 'string', description: 'Vault name' },
        filename:      { type: 'string', description: 'Filename including .md extension' },
        folder:        { type: 'string', description: 'Optional vault-relative folder' },
        field:         { type: 'string', description: 'Frontmatter key (any field except tags)' },
        expectedMtime: { type: 'string', description: 'Optional ISO 8601 mtime from a prior read-note/list-notes call; the write is refused if the note has changed since' },
      },
      required: ['vault', 'filename', 'field'],
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

// ── upload state ───────────────────────────────────────────────────────────

const UPLOAD_PREFIX = '/up/';
const MAX_OUTSTANDING_UPLOADS = 16;
const MAX_CONCURRENT_UPLOADS = 4;
const UPLOAD_STALL_MS = 30_000; // an upload that sends nothing for this long is cut off
const UPLOAD_MIN_RATE = 50_000; // bytes per second a slow but steady upload is allowed to drop to

const uploads = new UploadSlots({ ttlMs: UPLOAD_TTL_SECONDS * 1000, maxOutstanding: MAX_OUTSTANDING_UPLOADS });
setInterval(() => uploads.sweep(), 30_000).unref();
let activeUploads = 0;
let warnedForwardedFor = false;

/**
 * The address a request really comes from (see callerAddress). Logs a hint, once, if a
 * request carries X-Forwarded-For but its connection is not a trusted proxy: that is usually
 * a server behind a reverse proxy that has not set trustedProxies, where every caller would
 * otherwise look like the proxy.
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function clientAddress(req) {
  if (!warnedForwardedFor && req.headers['x-forwarded-for']
      && !TRUSTED_PROXIES.check(normalizeAddress(req.socket.remoteAddress))) {
    warnedForwardedFor = true;
    log('NOTE: a request carried X-Forwarded-For from a connection that is not in "trustedProxies", so the header was ignored. '
      + 'If this server runs behind a reverse proxy, set "trustedProxies" so upload addresses are checked correctly.');
  }
  return callerAddress(req, TRUSTED_PROXIES);
}

/**
 * Handles all incoming HTTP requests, including those with Expect: 100-continue.
 * Routes to upload handling, OAuth endpoints, or the MCP request handler.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response to send.
 */
async function handleRequest(req, res) {
  const url = req.url?.split('?')[0];
  // Only requests that say 'Expect: 100-continue' arrive through the 'checkContinue' listener,
  // and Node then leaves answering it to us. Upload requests are answered after their checks.
  if (EXPECTS_CONTINUE.test(req.headers.expect ?? '') && !url?.startsWith(UPLOAD_PREFIX)) res.writeContinue();
  // Validate session ID as a UUID — all legitimate IDs are created by randomUUID().
  // Non-matching values become '' so sessions.has('') is always false.
  const rawSid = req.headers['mcp-session-id']?.trim() || '';
  const sid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSid)
    ? rawSid : '';
  const safeMethod = req.method?.replace(/[^\w-]/g, '?') ?? 'UNKNOWN';
  // An upload URL's last part is a secret, so it is never logged.
  const safeUrl    = url?.startsWith(UPLOAD_PREFIX) ? '/up/<redacted>' : (url ?? '').replace(/[^\w/.-]/g, '?');
  const safeSid    = sid.slice(0, 8) || 'none';
  log(`${safeMethod} ${safeUrl} sid=${safeSid}`);

  try {
    await route(req, res, url, sid);
  } catch (err) {
    logErr('unhandled:', err);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
}

const server = http.createServer(handleRequest);
server.on('checkContinue', handleRequest);
// Node's default allows a whole request 300 s, and cannot be changed per request. The largest
// permitted upload must be able to finish at UPLOAD_MIN_RATE, so the limit is raised for every
// request on the server, but never beyond an hour. A stalled upload is cut off by UPLOAD_STALL_MS.
server.requestTimeout = Math.min(3_600_000, Math.max(300_000, Math.ceil(UPLOAD_MAX_BYTES / UPLOAD_MIN_RATE) * 1000));

// ── PUT /up/<token>: receiving an upload ───────────────────────────────────

// Node sends Expect: 100-continue requests to 'checkContinue' for any value containing the token.
const EXPECTS_CONTINUE = /(?:^|\W)100-continue(?:$|\W)/i;

/**
 * Answers an upload request, closing the connection afterwards. Whatever the client is still
 * sending (up to a limit) is read and discarded first, which gives it a chance to read the
 * answer instead of seeing the connection reset.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string|object} body - Plain text, or an object sent as JSON.
 * @param {object} [headers] - Extra response headers.
 */
function rejectUpload(req, res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const isText = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain' : 'application/json', Connection: 'close', ...headers });
  res.end(isText ? body : JSON.stringify(body));
  if (req.destroyed) return;
  let drained = 0;
  req.on('data', chunk => {
    drained += chunk.length;
    if (drained > 1_048_576) req.destroy();
  });
  req.resume();
}

/**
 * Reads an upload's body into a staging file, hashing it as it goes. Unlike stream.pipeline
 * this never destroys the request on failure, so the caller can still send an answer.
 * @param {http.IncomingMessage} req
 * @param {string} stagePath - Staging file to create (it must not exist).
 * @param {number} size - Declared size; more data than this is an error.
 * @returns {Promise<{received: number, digest: string}>}
 * @throws {Error} with message 'more data than declared', 'upload stalled',
 *   'upload aborted by the client', or the underlying file error.
 */
function receiveUpload(req, stagePath, size) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(stagePath, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let received = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.socket?.off('timeout', onStall);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      out.destroy();
      reject(err);
    };
    const onStall = () => fail(new Error('upload stalled'));
    const onData = (chunk) => {
      received += chunk.length;
      if (received > size) return fail(new Error('more data than declared'));
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    };
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ received, digest: hash.digest('hex') });
    });
    req.on('data', onData);
    req.on('error', fail);
    req.on('end', () => { if (!settled) out.end(); });
    req.on('close', () => { if (!req.complete) fail(new Error('upload aborted by the client')); });
    req.socket?.setTimeout(UPLOAD_STALL_MS);
    req.socket?.once('timeout', onStall);
  });
}

/**
 * Puts a received file in its place in the vault without overwriting anything. The file is
 * first copied to a hidden temporary name beside its destination (re-checking its hash as it
 * goes, and taking its permissions from the process's umask like any other file the vault
 * gets), then hard-linked to its real name, so the real name appears complete or not at all.
 * @param {object} vault - A configured vault.
 * @param {string} relPath - Vault-relative destination.
 * @param {string} stagePath - The received file.
 * @param {string} sha256 - The hash the received file must still have.
 * @returns {Promise<'ok'|'exists'|'denied'|'outside'|'corrupt'>}
 */
async function placeUpload(vault, relPath, stagePath, sha256) {
  if (_isDenied(vault.denyPaths, relPath)) return 'denied';
  const resolved = await resolveDestination(vault.path, relPath);
  if (!resolved.ok) return 'outside';
  if (_isDenied(vault.denyPaths, resolved.rel)) return 'denied';
  const dest = path.join(vault.path, relPath);
  try {
    await fs.access(dest);
    return 'exists';
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${stagingFileName()}`);
  try {
    const hash = createHash('sha256');
    const hasher = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
    await pipeline(createReadStream(stagePath), hasher, createWriteStream(tmp, { flags: 'wx' }));
    if (hash.digest('hex') !== sha256) return 'corrupt';
    try {
      await fs.link(tmp, dest);
    } catch (err) {
      if (err.code === 'EEXIST') return 'exists';
      // Filesystems without hard links: fall back to an exclusive copy.
      try {
        await fs.copyFile(tmp, dest, fsConstants.COPYFILE_EXCL);
      } catch (copyErr) {
        if (copyErr.code === 'EEXIST') return 'exists';
        await fs.unlink(dest).catch(() => {});
        throw copyErr;
      }
    }
    return 'ok';
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/**
 * Handles every request to /up/...: the one-time upload URL. The order matters: the slot is
 * used up first, so whatever the request turns out to be, the URL is dead afterwards. The
 * staging file is always removed before any answer (success or error) is sent to the client.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} url - The request path.
 */
async function handleUpload(req, res, url) {
  const slot = uploads.consume(url.slice(UPLOAD_PREFIX.length));
  if (!slot) return rejectUpload(req, res, 404, 'not found');
  if (req.method !== 'PUT') return rejectUpload(req, res, 405, 'method not allowed', { Allow: 'PUT' });
  if (req.headers.origin !== undefined) return rejectUpload(req, res, 403, 'forbidden origin');
  if (clientAddress(req) !== slot.address) return rejectUpload(req, res, 403, 'forbidden');

  const contentLength = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined || contentLength === undefined) {
    return rejectUpload(req, res, 411, { error: `Content-Length of ${slot.size} is required` });
  }
  if (!/^\d+$/.test(contentLength)) return rejectUpload(req, res, 400, { error: 'invalid Content-Length' });
  const length = Number(contentLength);
  if (length > slot.size) return rejectUpload(req, res, 413, { error: `Content-Length ${length} is larger than the declared size ${slot.size}` });
  if (length < slot.size) return rejectUpload(req, res, 400, { error: `Content-Length ${length} is smaller than the declared size ${slot.size}` });
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return rejectUpload(req, res, 503, { error: 'too many uploads in progress; request a new URL and try again shortly' }, { 'Retry-After': '5' });
  }

  const vault = VAULTS[slot.vault];
  const stagePath = path.join(UPLOAD_TEMP_DIR, stagingFileName());
  // The staging file is removed before any answer is sent, so a client that gets one can rely on it being gone.
  const discard = () => fs.unlink(stagePath).catch(() => {});
  const answer = async (status, body) => { await discard(); rejectUpload(req, res, status, body); };
  activeUploads++;
  try {
    if (EXPECTS_CONTINUE.test(req.headers.expect ?? '')) res.writeContinue();
    const { received, digest } = await receiveUpload(req, stagePath, slot.size);
    req.socket?.setTimeout(0);
    if (received !== slot.size) return await answer(400, { error: `received ${received} bytes, expected ${slot.size}` });
    if (digest !== slot.sha256) {
      return await answer(422, { error: 'sha256 does not match the declared hash', expected: slot.sha256, actual: digest });
    }
    const outcome = await placeUpload(vault, slot.relPath, stagePath, slot.sha256);
    if (outcome === 'denied' || outcome === 'outside') return await answer(403, { error: 'Access denied' });
    if (outcome === 'exists') return await answer(409, { error: 'destination already exists', path: slot.relPath });
    if (outcome === 'corrupt') return await answer(500, { error: 'the file changed while it was being placed; request a new URL and try again' });
    await discard();
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: slot.relPath, bytes: received, sha256: digest }));
  } catch (err) {
    const message = err.message.replaceAll(vault.path + '/', '').replaceAll(UPLOAD_TEMP_DIR + '/', '');
    if (message === 'upload aborted by the client') {
      log('upload aborted by the client');
    } else if (message === 'more data than declared') {
      log('upload refused: more data than declared');
      await answer(413, { error: 'more data than declared' });
    } else if (message === 'upload stalled') {
      log('upload cut off: stalled');
      await answer(408, { error: 'upload stalled' });
    } else {
      logErr('upload failed:', message);
      await answer(500, { error: 'upload failed' });
    }
  } finally {
    activeUploads--;
    if (!req.socket?.destroyed) req.socket?.setTimeout(0);
    await discard(); // a safety net for any path that did not already
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

async function route(req, res, url, sid) {
  // Upload URLs are handled first: the one-time slot must be used up by the first request
  // that names it, before any other check (including the Origin check below) can turn it away.
  if (url?.startsWith(UPLOAD_PREFIX)) return handleUpload(req, res, url);

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

  // static responses for methods this server doesn't support server-side
  if (msg.method === 'resources/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { resources: [] } }]);
  }
  if (msg.method === 'prompts/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { prompts: [] } }]);
  }
  if (msg.method === 'tools/list') {
    return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { tools: TOOLS } }]);
  }

  // list-vaults is answered directly from the configured vaults map
  if (msg.method === 'tools/call' && msg.params?.name === 'list-vaults') {
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

  // ── native tool handlers ──────────────────────────────────────────
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
        lines.push(`${rel}\t${formatMtime(stat)}`);
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

  if (msg.method === 'tools/call' && msg.params?.name === 'search-tags') {
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

  // ── Phase 2 native handlers ──────────────────────────────────────

  if (msg.method === 'tools/call' && msg.params?.name === 'read-note') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    // read-note reads any file as text, so a non-markdown file under denyBinaryPaths
    // (an SVG, CSV, text-layer PDF...) must be refused here as well as in read-binary-file.
    if (!relPath.toLowerCase().endsWith('.md') && isBinaryReadDenied(vault.denyBinaryPaths, relPath)) {
      return toolErr(res, sid, msgId, `Reading is restricted for '${relPath}'`);
    }
    try {
      const absPath = path.join(vault.path, relPath);
      const content = await libReadNote(absPath);
      const stat = await fs.stat(absPath);
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: {
        content: [
          { type: 'text', text: content },
          { type: 'text', text: `Last-Modified: ${formatMtime(stat)}` },
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
    if (!['append', 'prepend', 'replace', 'replace-section', 'delete-section', 'toggle-checkbox'].includes(op))
      return toolErr(res, sid, msgId, `Invalid operation: ${op}`);
    if ((op === 'replace-section' || op === 'delete-section') && !args.heading)
      return toolErr(res, sid, msgId, `heading is required for ${op}`);
    if (op === 'toggle-checkbox' && !args.taskText)
      return toolErr(res, sid, msgId, 'taskText is required for toggle-checkbox');
    const absPath = path.join(vault.path, relPath);
    try {
      if (args.expectedMtime !== undefined) await assertUnmodified(absPath, args.expectedMtime);
      if (op === 'replace') {
        await libWriteNote(absPath, args.content ?? '');
      } else if (op === 'replace-section') {
        const existing = await libReadNote(absPath);
        const updated = replaceSection(existing, args.heading, args.content ?? '', args.occurrence);
        await libWriteNote(absPath, updated);
      } else if (op === 'delete-section') {
        const existing = await libReadNote(absPath);
        const updated = deleteSection(existing, args.heading, args.occurrence);
        await libWriteNote(absPath, updated);
      } else if (op === 'toggle-checkbox') {
        const existing = await libReadNote(absPath);
        const updated = toggleCheckbox(existing, args.taskText, args.checked, args.occurrence);
        await libWriteNote(absPath, updated);
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
    const absPath = path.join(vault.path, relPath);
    try {
      if (args.expectedMtime !== undefined) await assertUnmodified(absPath, args.expectedMtime);
      const permanent = args.permanent === true;
      await libDeleteNote(absPath, permanent, vault.path);
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
    // move-note does a plain rename and accepts any file, so it must not be a route for
    // taking a protected non-markdown file out of protection; markdown notes are unaffected.
    if (!srcRel.toLowerCase().endsWith('.md')) {
      const escapes = checkBinaryMove(vault.denyBinaryPaths, srcRel, dstRel);
      if (escapes) return toolErr(res, sid, msgId, escapes);
    }
    try {
      if (args.expectedMtime !== undefined) await assertUnmodified(path.join(vault.path, srcRel), args.expectedMtime);
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

  if (msg.method === 'tools/call' && msg.params?.name === 'fetch-binary-file') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (relPath.toLowerCase().endsWith('.md')) return toolErr(res, sid, msgId, 'Use create-note for .md files');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    if (!args.url) return toolErr(res, sid, msgId, 'url is required');
    // Number(), not parseInt() — parseInt silently truncates a decimal or trailing
    // garbage ("1.5"/"100abc" -> 100) instead of rejecting it; these are caller
    // input, unlike the config file's own already-parseInt-style numeric fields.
    const maxBytes = args.maxBytes !== undefined ? Number(args.maxBytes) : FETCH_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return toolErr(res, sid, msgId, 'maxBytes must be a positive integer');
    const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : FETCH_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return toolErr(res, sid, msgId, 'timeoutMs must be a positive integer');
    const absPath = path.join(vault.path, relPath);
    // Destination existence is confirmed before any network call, so a colliding
    // path never causes an outbound request; fetchToBuffer validates the URL (and
    // every redirect hop) before the request that follows it.
    try {
      await fs.access(absPath);
      return toolErr(res, sid, msgId, `File already exists: ${relPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
    try {
      const buffer = await fetchToBuffer(args.url, { maxBytes, timeoutMs });
      await libWriteBinaryFile(absPath, buffer);
      return toolOk(res, sid, msgId, `Created: ${relPath} (${buffer.length} bytes)`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'upload-binary-file') {
    const args = msg.params.arguments ?? {};
    const vault = Object.hasOwn(VAULTS, args.vault) ? VAULTS[args.vault] : undefined;
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (relPath.toLowerCase().endsWith('.md')) return toolErr(res, sid, msgId, 'Use create-note for .md files');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    const { size, sha256 } = args;
    if (!Number.isInteger(size) || size < 1) return toolErr(res, sid, msgId, 'size must be a positive whole number of bytes');
    if (size > UPLOAD_MAX_BYTES) return toolErr(res, sid, msgId, `size ${size} is larger than the ${UPLOAD_MAX_BYTES}-byte upload limit`);
    if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      return toolErr(res, sid, msgId, 'sha256 must be 64 hexadecimal characters: the SHA-256 of the file, from a tool such as sha256sum');
    }
    try {
      const resolved = await resolveDestination(vault.path, relPath);
      if (!resolved.ok || _isDenied(vault.denyPaths, resolved.rel)) return toolErr(res, sid, msgId, 'Access denied');
      await fs.access(path.join(vault.path, relPath));
      return toolErr(res, sid, msgId, `File already exists: ${relPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
    let slot;
    try {
      slot = uploads.create({ vault: args.vault, relPath, size, sha256, address: clientAddress(req) });
    } catch (err) {
      if (err.code === 'TOO_MANY_SLOTS') {
        return toolErr(res, sid, msgId, 'Too many pending uploads. Wait for one to finish or expire, then try again');
      }
      if (err.code === 'NO_ADDRESS') {
        return toolErr(res, sid, msgId, 'Could not work out the address this request came from, so an upload cannot be reserved. If the server is behind a reverse proxy, check "trustedProxies"');
      }
      throw err;
    }
    const url = `${BASE_URL.replace(/\/+$/, '')}${UPLOAD_PREFIX}${slot.token}`;
    return toolOk(res, sid, msgId, [
      `Upload reserved: ${relPath} (${size} bytes, sha256 ${sha256.toLowerCase()}).`,
      `URL: ${url}`,
      `Valid for ${UPLOAD_TTL_SECONDS} seconds, for one request only, and only from the address that made this request.`,
      'Send the file with:',
      `curl --fail-with-body -sS -T "<path-to-file>" "${url}"`,
      'Replace <path-to-file> with the local file. If the upload fails for any reason, request a new URL.',
    ].join('\n'));
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'read-binary-file') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (relPath.toLowerCase().endsWith('.md')) return toolErr(res, sid, msgId, 'Use read-note for .md files');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    if (isBinaryReadDenied(vault.denyBinaryPaths, relPath)) return toolErr(res, sid, msgId, `Reading is restricted for '${relPath}'`);
    const absPath = path.join(vault.path, relPath);
    try {
      // Resolve symlinks first and judge the real location, so a link can neither reach a
      // file outside the vault nor alias a protected or denied file from an open folder.
      const realVault = await fs.realpath(vault.path);
      const realAbs = await fs.realpath(absPath);
      const realRel = path.relative(realVault, realAbs);
      if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
        return toolErr(res, sid, msgId, `Access denied: path resolves outside the vault: ${relPath}`);
      }
      const resolvedRel = realRel.split(path.sep).join('/');
      if (_isDenied(vault.denyPaths, resolvedRel)) return toolErr(res, sid, msgId, 'Access denied');
      if (isBinaryReadDenied(vault.denyBinaryPaths, resolvedRel)) return toolErr(res, sid, msgId, `Reading is restricted for '${relPath}'`);
      // Size is checked from stat before the file is read, so an oversized file is never loaded.
      const stat = await fs.stat(realAbs);
      if (!stat.isFile()) return toolErr(res, sid, msgId, `Not a regular file: ${relPath}`);
      if (stat.size > READ_MAX_BYTES) {
        return toolErr(res, sid, msgId, `File is ${stat.size} bytes, which exceeds the ${READ_MAX_BYTES}-byte read limit: ${relPath}`);
      }
      const buffer = await libReadBinaryFile(realAbs);
      // The file can grow between stat and read; the cap is enforced on what was actually read.
      if (buffer.length > READ_MAX_BYTES) {
        return toolErr(res, sid, msgId, `File is ${buffer.length} bytes, which exceeds the ${READ_MAX_BYTES}-byte read limit: ${relPath}`);
      }
      const mimeType = mimeTypeFor(relPath);
      const uri = `file:///${relPath.split('/').map(encodeURIComponent).join('/')}`;
      return sendSse(res, 200, sid, [{ jsonrpc: '2.0', id: msgId, result: { content: [
        { type: 'text', text: `${relPath} (${buffer.length} bytes, ${mimeType})` },
        { type: 'resource', resource: { uri, mimeType, blob: buffer.toString('base64') } },
      ] } }]);
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
    const absPath = path.join(vault.path, relPath);
    try {
      if (args.expectedMtime !== undefined) await assertUnmodified(absPath, args.expectedMtime);
      const permanent = args.permanent === true;
      await libDeleteBinaryFile(absPath, permanent, vault.path);
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
    const escapes = checkBinaryMove(vault.denyBinaryPaths, srcRel, dstRel);
    if (escapes) return toolErr(res, sid, msgId, escapes);
    try {
      if (args.expectedMtime !== undefined) await assertUnmodified(path.join(vault.path, srcRel), args.expectedMtime);
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

  if (msg.method === 'tools/call' && msg.params?.name === 'create-folder') {
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
    if (args.expectedMtime !== undefined) {
      if (typeof args.expectedMtime !== 'object' || args.expectedMtime === null || Array.isArray(args.expectedMtime))
        return toolErr(res, sid, msgId, 'expectedMtime must be an object mapping vault-relative path to ISO 8601 mtime');
      // Validate every non-denied file's precondition before any file is written,
      // so a batch either applies wholly or not at all. This creates a window between
      // validating file N and writing it where drift can occur (proportional to batch
      // size), which is intentional and consistent with the compare-and-swap design
      // (not a lock). See assertUnmodified() JSDoc: we guard against realistic conflicts
      // (edits seconds/minutes old), not same-instant races.
      for (const file of files) {
        const relPath = normPath(file);
        if (_isDenied(vault.denyPaths, relPath)) continue; // will be skipped below regardless
        const expected = args.expectedMtime[file] ?? args.expectedMtime[relPath];
        if (expected === undefined) return toolErr(res, sid, msgId, `expectedMtime missing for ${relPath}`);
        try {
          await assertUnmodified(path.join(vault.path, relPath), expected);
        } catch (err) {
          return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
        }
      }
    }
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

  if (msg.method === 'tools/call' && msg.params?.name === 'set-frontmatter-field') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    if (!args.field) return toolErr(res, sid, msgId, 'field is required');
    if (args.field === 'tags') return toolErr(res, sid, msgId, 'Use add-tags/remove-tags/rename-tag for the tags field');
    if (!FIELD_NAME_RE.test(args.field)) return toolErr(res, sid, msgId, 'field must be a simple key (letters, digits, _, -)');
    if (!['string', 'number', 'boolean'].includes(typeof args.value))
      return toolErr(res, sid, msgId, 'value must be a string, number, or boolean');
    try {
      const absPath = path.join(vault.path, relPath);
      if (args.expectedMtime !== undefined) await assertUnmodified(absPath, args.expectedMtime);
      const content = await libReadNote(absPath);
      const updated = setFrontmatterField(content, args.field, args.value);
      await libWriteNote(absPath, updated);
      return toolOk(res, sid, msgId, `Set ${args.field} on ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
  }

  if (msg.method === 'tools/call' && msg.params?.name === 'remove-frontmatter-field') {
    const args = msg.params.arguments ?? {};
    const vault = VAULTS[args.vault];
    if (!vault) return toolErr(res, sid, msgId, `Unknown vault: ${args.vault}`);
    const relPath = normPath(args.folder, args.filename);
    if (!relPath) return toolErr(res, sid, msgId, 'filename is required');
    if (_isDenied(vault.denyPaths, relPath)) return toolErr(res, sid, msgId, 'Access denied');
    if (!args.field) return toolErr(res, sid, msgId, 'field is required');
    if (args.field === 'tags') return toolErr(res, sid, msgId, 'Use add-tags/remove-tags/rename-tag for the tags field');
    if (!FIELD_NAME_RE.test(args.field)) return toolErr(res, sid, msgId, 'field must be a simple key (letters, digits, _, -)');
    try {
      const absPath = path.join(vault.path, relPath);
      if (args.expectedMtime !== undefined) await assertUnmodified(absPath, args.expectedMtime);
      const content = await libReadNote(absPath);
      const updated = removeFrontmatterField(content, args.field);
      if (updated === content) return toolOk(res, sid, msgId, 'No changes needed');
      await libWriteNote(absPath, updated);
      return toolOk(res, sid, msgId, `Removed ${args.field} from ${relPath}`);
    } catch (err) {
      return toolErr(res, sid, msgId, err.message.replaceAll(vault.path + '/', ''));
    }
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

/**
 * Creates the staging folder, checks (after resolving symbolic links) that it is not inside a
 * vault, and removes stale staging files left by an earlier run. Exits if it cannot be used.
 */
async function prepareStagingDir() {
  const realOrResolved = async (p) => fs.realpath(p).catch(() => path.resolve(p));
  try {
    await fs.mkdir(CONFIGURED_UPLOAD_TEMP_DIR, { recursive: true, mode: 0o700 });
    // A symbolic link at the default location can only be someone else's doing, since the owner
    // never put it there. A configured folder may legitimately be a link, and is resolved once.
    if (UPLOAD_TEMP_DIR_IS_DEFAULT && (await fs.lstat(CONFIGURED_UPLOAD_TEMP_DIR)).isSymbolicLink()) {
      throw new Error('it is a symbolic link, which the default location must not be. Choose a folder of your own with "uploadTempDir"');
    }
    const realStaging = await fs.realpath(CONFIGURED_UPLOAD_TEMP_DIR);
    // mkdir's mode only applies to a folder it creates. A folder that already existed, in a
    // shared temporary directory for example, may belong to someone else or be open to them,
    // and whoever controls it could swap a file between its hash check and its placement.
    const stat = await fs.stat(realStaging);
    const ownerProblem = checkStagingDirOwner(stat, process.getuid?.());
    if (ownerProblem) throw new Error(`it ${ownerProblem}. Choose a folder of your own with "uploadTempDir"`);
    if (stat.mode & 0o077) {
      await fs.chmod(realStaging, 0o700);
      log(`restricted the permissions of ${realStaging} to its owner`);
    }
    const problem = checkStagingDir(
      realStaging,
      await Promise.all(Object.values(VAULTS).map(v => realOrResolved(v.path))),
    );
    if (problem) throw new Error(`it ${problem}`);
    UPLOAD_TEMP_DIR = realStaging;
    const removed = await sweepStaging(UPLOAD_TEMP_DIR);
    if (removed) log(`removed ${removed} stale upload file(s) from ${UPLOAD_TEMP_DIR}`);
  } catch (err) {
    logErr(`Cannot use "uploadTempDir" ${CONFIGURED_UPLOAD_TEMP_DIR}: ${err.message}`);
    process.exit(1);
  }
}
await prepareStagingDir();

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`obsidian-mcp server listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
