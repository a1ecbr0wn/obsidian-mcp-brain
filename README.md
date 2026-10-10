# Obsidian MCP Tools

A couple of tools to enable remote https access to an Obsidian MCP server.

## obsidian-mcp-brain

A thin Node.js HTTP server that provides remote MCP access to an Obsidian vault.
It implements all MCP tools natively and exposes them to remote clients such as
Claude Code and Claude Desktop via HTTP.

## Why this server is needed

Remote MCP clients (Claude Code 2.x, Claude Desktop) connect over HTTP, not stdio,
and the standard approaches have issues:

### No HTTP transport for local MCP servers

Existing solutions like [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) wrap
stdio MCP servers and expose them over HTTP. However, mcp-proxy has a session-management
bug: when Claude Code opens its GET `/mcp` notification stream at the same time
as sending tool-list requests (which it always does), mcp-proxy's response routing
gets confused and `tools/list` silently times out. This server implements the MCP
HTTP transport layer directly and implements all tools natively, eliminating that
class of bug.

### No OAuth 2.0 discovery

The [MCP 2025-03-26 spec](https://spec.modelcontextprotocol.io) requires every
non-localhost remote MCP server to expose OAuth 2.0 discovery endpoints
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/authorize`, `/token`, `/register`). Without them, Claude Code refuses to connect.
This server serves a public (no credentials required) OAuth flow so that Claude
Code's auth handshake completes without needing real credentials.

### What this server does

```text
Claude Code / Claude Desktop
        │  HTTPS (e.g. Tailscale)
        ▼
obsidian-mcp-brain  :3002
  ├─ OAuth 2.0 discovery endpoints
  ├─ MCP Streamable HTTP transport (POST /mcp, GET /mcp)
  ├─ Path deny list (access control)
  └─ Vault access (node:fs/promises)
        │
        ▼
Obsidian vault (filesystem)
```

---

### Prerequisites

- Node.js 18+
- A way to expose the server over HTTPS to your remote client —
  [Tailscale Serve](https://tailscale.com/kb/1312/serve) is recommended, because it
  also keeps the server on an overlay network, but any HTTPS reverse proxy on a
  private network works
- **Optional:** The `query-graph` tool (which queries a vault using a natural-language
  knowledge graph) requires the `graphify` CLI to be installed and on `PATH`, and
  a knowledge graph to be pre-built for that vault (run `graphify --obsidian`
  against it once, before calling the tool). `query-graph` is always listed, but
  calling it against a vault with no graph returns a clear error rather than an
  answer.

---

### Installation

Install dependencies and build the packages:

```bash
npm install
```

The `obsidian-mcp-brain` package can then be run directly from the workspace, or
you can copy the built files to wherever you want to run them from. Then set it
up as a persistent service.

### systemd (Linux)

First, create your config file — see [Configuration](#configuration) below for its
full shape. By default the server reads `~/.config/obsidian-mcp.json`, so no extra
environment variable is needed unless you want the config somewhere else.

Then create `~/.config/systemd/user/obsidian-mcp.service`:

```ini
[Unit]
Description=Obsidian MCP Server
After=network.target

[Service]
ExecStart=node /path/to/obsidian-mcp-brain/obsidian-mcp-brain/obsidian-mcp-brain.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

(If your config file lives somewhere other than `~/.config/obsidian-mcp.json`, add
`Environment=CONFIG_PATH=/path/to/your/config.json` under `[Service]`.)

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now obsidian-mcp.service
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.obsidian-mcp-brain.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.obsidian-mcp-brain</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/obsidian-mcp-brain/obsidian-mcp-brain/obsidian-mcp-brain.mjs</string>
  </array>

  <!-- Only needed if your config file isn't at the default
  ~/.config/obsidian-mcp.json -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONFIG_PATH</key>
    <string>/path/to/your/obsidian-mcp.json</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/obsidian-mcp-brain.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/obsidian-mcp-brain.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.obsidian-mcp-brain.plist
```

To restart after a config change:

```bash
launchctl unload ~/Library/LaunchAgents/com.obsidian-mcp-brain.plist
launchctl load   ~/Library/LaunchAgents/com.obsidian-mcp-brain.plist
```

### Docker

Instead of installing Node.js, you can run the server from the container image
published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`. It
is configured with the same JSON file as every other install; only two things
differ from a native run:

- `listenHost` must be `"0.0.0.0"`, so the port you publish can reach the server
  inside the container (the default, `127.0.0.1`, is unreachable from outside it).
- Vault paths in the config are paths *inside* the container, so mount each vault
  there (below, at `/vaults/knowledge`).

```json
{
  "listenHost": "0.0.0.0",
  "mcpBaseUrl": "https://your-hostname:4001",
  "vaults": {
    "knowledge": { "path": "/vaults/knowledge" }
  }
}
```

```bash
docker run -d --name obsidian-mcp-brain --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -v /path/to/your/obsidian/vault:/vaults/knowledge \
  -v /path/to/obsidian-mcp.json:/config/obsidian-mcp.json:ro \
  -p 127.0.0.1:3002:3002 \
  ghcr.io/a1ecbr0wn/obsidian-mcp-brain
```

The port is published on the host's loopback only, so put HTTPS in front of it the
same way as for a native install (the Tailscale Serve command below works
unchanged). `--user` makes the container write to your vault as you; without it the
container runs as an unprivileged user with UID 1000. If you change `listenPort`,
publish that port instead of `3002`.

The image does not include `graphify`, so `query-graph` always returns an error in a
container ("graphify command not found on PATH" once the vault has a graph); use a
native install if you need that tool. Everything else works. See the
[Docker install guide](https://brain.a1ecbr0wn.com/install/install-docker) for a
`docker compose` example and hardening options.

### Tailscale Serve (HTTPS tunnel)

Point Tailscale at the server's local port:

```bash
sudo tailscale serve --bg --https 4001 http://localhost:3002
```

This exposes the server at `https://<your-tailscale-hostname>:4001`.

---

## Configuration

All configuration lives in one JSON file — no environment variables are read except
`CONFIG_PATH`, which says where to find it.

- **Location**: `CONFIG_PATH` env var if set, otherwise `~/.config/obsidian-mcp.json`.
- The server serves one or more named vaults from a single process; a client picks
  which one a call applies to via the `vault` argument every tool except `list-vaults` takes.

### Shape

```json
{
  "listenPort": 3002,
  "listenHost": "127.0.0.1",
  "mcpBaseUrl": "https://your-hostname:4001",
  "denyPaths": ["private"],
  "denyBinaryPaths": ["**/*.pdf"],
  "graphifyQueryTimeoutMs": 60000,
  "fetchMaxBytes": 10485760,
  "fetchTimeoutMs": 30000,
  "readMaxBytes": 10485760,
  "uploadMaxBytes": 52428800,
  "uploadTtlSeconds": 300,
  "uploadTempDir": "/var/tmp/obsidian-mcp-uploads",
  "trustedProxies": ["127.0.0.1", "::1"],
  "vaults": {
    "knowledge": {
      "path": "/path/to/your/obsidian/vault"
    },
    "work": {
      "path": "/path/to/another/vault",
      "denyPaths": ["confidential"],
      "denyBinaryPaths": ["scans"]
    }
  }
}
```

| Field                    | Required | Default    | Description                                                                             |
| ------------------------ | -------- | ---------- | ----------------------------------------------------------------------------------------- |
| `mcpBaseUrl`             | Yes      | —          | Public HTTPS base URL of the server (scheme, host and port, no path or trailing slash); used in OAuth responses, SSE endpoint events and upload URLs |
| `vaults`                 | Yes      | —          | Non-empty object of `{ "name": { "path": "..." } }`. Each vault needs at least a `path` |
| `listenPort`             | No       | `3002`     | Local port the server listens on                                                        |
| `listenHost`             | No       | `127.0.0.1` | Address the server binds to. Leave it as loopback unless the server runs in a container, where `0.0.0.0` is needed for the published port to reach it |
| `denyPaths`              | No       | `[]`       | Vault-relative paths to block, applied to every vault. See below                        |
| `denyBinaryPaths`        | No       | `[]`       | Vault-relative files/folders, with wildcards, whose binary files `read-binary-file` refuses to return. See below |
| `graphifyQueryTimeoutMs` | No       | `60000`    | Timeout for a `graphify query` subprocess (milliseconds)                                |
| `fetchMaxBytes`          | No       | `10485760` | Default max response size for `fetch-binary-file` (bytes); overridable per call         |
| `fetchTimeoutMs`         | No       | `30000`    | Default request timeout for `fetch-binary-file` (milliseconds); overridable per call    |
| `readMaxBytes`           | No       | `10485760` | Largest file `read-binary-file` will return (bytes, measured on disk)                   |
| `uploadMaxBytes`         | No       | `52428800` | Largest file `upload-binary-file` will reserve an upload for (bytes)                         |
| `uploadTtlSeconds`       | No       | `300`      | How long an upload URL lasts (seconds)                                                  |
| `uploadTempDir`          | No       | `obsidian-mcp-uploads-<user id>` under the system temp folder | Absolute path where uploads are held while received; must not be inside a vault and must belong to the server's user |
| `trustedProxies`         | No       | `[]`       | Addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For` is believed. See below |

Each vault entry can also set its own `denyPaths` and `denyBinaryPaths`, which are added on top of the
global list for that vault only (see below).

### Path deny list (`denyPaths`)

`denyPaths` lets you prevent the MCP client from reading or writing specific
folders in a vault. Paths are relative to the vault root and prefix-matched, so
denying `people` blocks `people/`, `people/alice/notes.md`, and so on.

The top-level `denyPaths` applies to every configured vault. A vault's own
`denyPaths` (if any) is added on top of that global list, restricting that vault
further without affecting any other vault:

```json
{
  "denyPaths": ["private"],
  "vaults": {
    "knowledge": { "path": "/path/to/your/obsidian/vault" },
    "work": { "path": "/path/to/another/vault", "denyPaths": ["confidential", "drafts"] }
  }
}
```

Here, both vaults block `private`; `work` additionally blocks `confidential` and
`drafts`, while `knowledge` is unaffected by that extra restriction.

The deny list is enforced before the tool reads or writes any file.
Blocked requests receive a structured MCP error (`isError: true`) rather than a
transport-level failure, so the client can report the reason clearly.

Affected tools: `read-note`, `create-note`, `edit-note`, `delete-note`, `move-note`
(source and destination), `create-binary-file`, `fetch-binary-file`, `read-binary-file`, `delete-binary-file`,
`move-binary-file` (source and destination), `find-backlinks`, `resolve-wikilink`,
`add-tags`, `remove-tags`, `set-frontmatter-field`, `remove-frontmatter-field`,
`create-folder`, `search-vault` (when a `path` scope is given).

`list-notes`, `list-tags`, `search-tags`, `new-notes`, `changed-notes`, and `rename-tag`
are equally protected, just via a different mechanism: instead of a single check up
front, they filter out denied files individually as they walk the vault.

`list-vaults` doesn't touch vault files at all — it just returns configured
vault names — so it's the only tool genuinely unaffected by the deny list.
`query-graph` takes a free-text question rather than a vault path, so it isn't subject
to the deny list either. **Warning**: if the graphify graph was built over denied folders,
the tool can reveal their content; build the graph from a vault without denied folders,
or leave the tool unused.

### Write preconditions (`expectedMtime`)

Every tool that writes to an existing file accepts an optional `expectedMtime`: the
ISO 8601 last-modified timestamp you previously got back from `read-note` or
`list-notes`. Pass it back on a later write and the server refuses the write — with
no changes made — if the file's mtime has moved since, telling you both the
timestamp you expected and its actual current one so you know to re-read and retry.

This is a compare-and-swap check, not a lock: it's meant to catch "I read this note
a while ago, and something else touched it since," not to serialize concurrent
writers. It's optional so existing callers are unaffected, but a client following a
read-then-write pattern (read a note, decide what to change, write it back) should
always pass it — otherwise an edit made by something else in between is silently
overwritten.

```
read-note  → note content + Last-Modified: 2026-09-20T10:15:00.000Z
...decide what to change...
edit-note  → { operation: "replace", content: "...", expectedMtime: "2026-09-20T10:15:00.000Z" }
```

Applies to: `edit-note` (all operations), `delete-note`, `move-note` (checked against
the source file), `set-frontmatter-field`, `remove-frontmatter-field`,
`move-binary-file` and `delete-binary-file` (checked against the source file). For
`add-tags`/`remove-tags`, which operate on a `files[]` array, `expectedMtime` is
instead an object mapping each vault-relative path to its expected timestamp; every
listed file's precondition is checked before any file in the batch is written, so
the batch either applies wholly or not at all.

Not applicable to `create-note`, `create-binary-file`, or `fetch-binary-file`, which
already fail if the destination exists, nor to `rename-tag`, which sweeps the whole
vault rather than targeting one file.

### edit-note operations

Beyond `append`, `prepend`, and `replace`, `edit-note` supports targeted,
section-scoped edits so a large note doesn't need to be resent in full for a small
change:

- **`replace-section`** — replaces the content under a heading (matched by exact
  text), leaving the heading line itself in place.
- **`delete-section`** — removes a heading and everything under it, heading line
  included.
- **`toggle-checkbox`** — flips (or explicitly sets) a `- [ ]`/`- [x]` line, matched
  by its exact text.

If a `heading` or `taskText` match isn't unique in the note, the call fails with a
list of every match (line number, and heading level where relevant); pass the
1-based `occurrence` from that list on a follow-up call to disambiguate.

### fetch-binary-file

`create-binary-file` requires the client to send the file as base64 — expensive
through an LLM client, since base64 is read in and written out again on top of its
already-larger-than-binary size. `fetch-binary-file` instead has the server download
a URL itself and write the result, so the client only ever sends a URL string.

```
fetch-binary-file → { filename: "photo.jpg", folder: "attachments", url: "https://example.com/photo.jpg" }
```

Because the server performs the request itself, a caller-supplied URL is effectively
asking this host to make an arbitrary outbound call — on any deployment, this host
may be able to reach private network services that shouldn't be exposed to a remote
MCP client. `fetch-binary-file` treats this as its primary risk:

- Only `http`/`https` URLs are accepted.
- The hostname is resolved and the request is refused if any resolved address is
  loopback, link-local, RFC1918, CGNAT, IETF protocol/benchmarking/documentation,
  multicast, reserved (all IPv4); loopback, link-local, site-local, unique-local,
  Teredo, discard-only, 6to4, NAT64, IPv4-compatible, and multicast (all IPv6);
  or IPv4-mapped IPv6 (automatically unwrapped to check the embedded IPv4).
- Every redirect hop is re-validated the same way — not just the initial URL — since
  a public hostname can redirect to a private address.
- The response body is size-checked while streaming, so an oversized response is
  aborted mid-transfer rather than after it's already been downloaded.
- A hard timeout (`fetchTimeoutMs`, overridable per call) aborts a slow or hanging
  response.
- The destination path is deny-path- and collision-checked *before* any network
  call, so a denied or already-occupied path never causes an outbound request.

`maxBytes` and `timeoutMs` can be overridden per call; otherwise they default to the
config file's `fetchMaxBytes`/`fetchTimeoutMs`.

---

### read-binary-file

`read-binary-file` returns an existing binary file (a PDF, say) to the client as two
content blocks: a text line (`attachments/report.pdf (48213 bytes, application/pdf)`)
and an MCP embedded `resource` carrying the base64 bytes and the file's `mimeType`.

```
read-binary-file → { filename: "report.pdf", folder: "attachments" }
```

The server never parses a PDF, extracts text, renders pages or runs OCR, so it needs
no extra software; the client does the reading, which is why one tool covers a PDF
with a real text layer and a scanned PDF whose text is only in images. In Claude Code
the bytes are saved to a file and the agent opens that path with its `Read` tool
(checked end to end for both kinds of PDF); other clients have not been checked.
The `filename` must not end in `.md`; use `read-note` for notes. A file larger than
`readMaxBytes` (10 MiB by default) is refused before it is read.

### upload-binary-file

`create-binary-file` needs the model to write the whole file out as base64, which is
impractical beyond a few tens of kilobytes (an 810 KB PDF is about a million tokens) and
gives no way to check the file arrived intact. `upload-binary-file` reserves a one-time URL
that the agent sends the file to directly, so its bytes never pass through the model:

```
upload-binary-file → { filename: "report.pdf", folder: "attachments", size: 810490, sha256: "<64 hex characters>" }
curl --fail-with-body -sS -T report.pdf "https://server:4001/up/<random token>"
```

The size and SHA-256 come from a tool (`wc -c`, `sha256sum`), never from the model. The
URL is the config's `mcpBaseUrl` (scheme, host and port, no path or trailing slash), then
`/up/`, then a random token. The server checks the received bytes against the declared
size and hash and places the file only if both match; otherwise it discards it.

- The URL works for **one request only**: the first request that names it uses it up,
  whatever that request is. If anything goes wrong, request a new URL.
- It works only from the **same address** as the call that reserved it, and lasts
  `uploadTtlSeconds` (300 by default).
- The `filename` must not end in `.md`, the destination must not exist, and `denyPaths`
  is checked when the URL is reserved and again when the file is placed.
- At most `uploadMaxBytes` (50 MiB by default), 16 pending URLs and 4 uploads at once.
- The file is held in `uploadTempDir` until verified, never inside a vault. At startup the
  server refuses a staging folder owned by another user, and tightens one that others can
  access to owner-only.
- Symbolic links in the destination are followed before the deny rules are checked, so an
  upload can't be used to write outside the vault.
- Behind a reverse proxy, set `trustedProxies` to the proxy's address (for example
  `["127.0.0.1", "::1"]`) so the address check can see the real caller from
  `X-Forwarded-For`. The header is ignored from any other connection. Without it the
  check always passes, and a hint is logged once.

It needs an agent with a shell on a machine that can reach the server's address, such as
Claude Code. The token limits one upload to one destination but is not authentication:
anyone who can call the server's tools can reserve a URL, and the URL is visible in the
conversation, which is why it is short-lived and single-use. `curl` exits with code 22
and prints the server's explanation on any failure: `403` wrong address or an `Origin`
header, `404` unknown, used or expired URL, `409` destination appeared meanwhile, `411`
no `Content-Length`, `413` or `400` size mismatch, `422` hash mismatch, `503` too many
uploads at once.

### Binary read protection (`denyBinaryPaths`)

`denyPaths` removes a path from every tool; `denyBinaryPaths` only stops the agent
reading a binary file's *contents* with `read-binary-file`. The files stay visible:
the agent can still create, move and delete them, and `find-backlinks` still sees
them. Each entry is a vault-relative path with optional wildcards:

- `*` matches any run of characters within one path segment, `?` matches one
  character within a segment, and `**` as a whole segment matches any number of
  segments, including none. Everything else is literal; matching is case-sensitive.
- An entry protects a path it matches and everything under a folder it matches.
  `scans` protects `scans/a.pdf` and `scans/2026/b.pdf` but not `scans-old/a.pdf`;
  `**/*.pdf` protects every PDF in the vault; `*/scans` protects `a/scans/x.pdf`.

As with `denyPaths`, the top-level list applies to every vault and a vault's own list
is added on top. A refused read returns `Reading is restricted for '<path>'`.
`move-binary-file` (and `move-note`, for a non-`.md` file) refuses to move a protected
file to a path that is not protected (judged by the destination's final path, so
renaming `scan.pdf` to `scan.txt` under `**/*.pdf` is refused too); moving within the
protected area, or moving an unprotected file in, is allowed.

To keep the protection from being sidestepped, `.trash` is protected automatically
whenever any `denyBinaryPaths` are set (a non-permanent delete moves a file there),
`read-note` refuses a protected non-`.md` file, and `read-binary-file` resolves
symbolic links and checks the real location, refusing a link that points outside the
vault. The other tools judge a path as given and don't resolve symlinks, so don't put
symlinks to sensitive files in a served vault.

## Connecting Claude Code

Add the server to your Claude Code config (`~/.claude.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "https://your-hostname:4001/mcp"
    }
  }
}
```

Claude Code will prompt you to authenticate the first time — click through the
OAuth flow (it uses a public/no-credentials token, so no real account is needed).

---

## Connecting Claude Desktop

Unlike Claude Code, Claude Desktop doesn't speak the MCP Streamable HTTP transport
directly — it only launches local stdio subprocesses. To reach a remote server like
this one, it needs a small relay in between that translates its stdio JSON-RPC
traffic into HTTP+SSE calls against the server's `/mcp` endpoint. Two options:

- **[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) via `npx`** (below) —
  the quickest option, no install or local files needed, good for a plain
  no-credentials setup like this server's public OAuth flow.
- **This repo's own [`mcp-shim`](#mcp-shim)** — a zero-dependency local script,
  worth using instead if you need a bearer token, a custom request timeout, or
  want to avoid an `npx` download on every Claude Desktop launch.

Edit `claude_desktop_config.json` (find it via **Claude Desktop → Settings →
Developer → Edit Config**) and add an entry under `mcpServers`, replacing the URL
below with your server's actual address:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://your-hostname:4001/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop after saving.

---

## Available Tools

| Tool | Description |
| --- | --- |
| `list-notes` | List all notes in the vault, or scoped to a folder. Returns sorted vault-relative paths, each with a last-modified timestamp |
| `list-tags` | List all unique tags (YAML frontmatter) used across vault notes, optionally scoped to a subdirectory |
| `search-tags` | Find notes that have ALL of the specified tags |
| `new-notes` | List notes created in the last 7 days, or since a provided timestamp |
| `changed-notes` | List notes modified in the last 7 days, or since a provided timestamp |
| `list-vaults` | List all configured vaults |
| `read-note` | Read a note's content and last-modified timestamp |
| `create-note` | Create a new note. Fails if it already exists |
| `edit-note` | Edit a note: append, prepend, replace, replace/delete the content under a heading, or toggle a checkbox |
| `delete-note` | Delete a note, moving it to `.trash` by default |
| `move-note` | Move or rename a note, rewriting all vault-wide wikilinks to the old path |
| `create-binary-file` | Create a new binary file (e.g. an image) from base64-encoded content. Fails if it already exists |
| `fetch-binary-file` | Create a new binary file by downloading a URL server-side, so the client only sends a URL, not the file content |
| `upload-binary-file` | Reserve a one-time upload URL for a binary file of a declared size and SHA-256; the agent sends the file to it with `curl`, so its bytes never pass through the model |
| `read-binary-file` | Return an existing binary file (e.g. a PDF) to the client as an embedded base64 resource, so the agent can read it |
| `move-binary-file` | Move or rename a binary file, rewriting all vault-wide wikilink embeds pointing at the old path |
| `delete-binary-file` | Delete a binary file, moving it to `.trash` by default |
| `find-backlinks` | Find all notes that link to or embed a given note or binary file |
| `resolve-wikilink` | Resolve a wikilink target string to the vault-relative file(s) it points to |
| `create-folder` | Create a new folder (and any missing parents) in the vault |
| `search-vault` | Search vault notes by content, filename, or both |
| `add-tags` | Add tags to notes in frontmatter and/or inline body content |
| `remove-tags` | Remove tags from notes in frontmatter and/or inline body content |
| `rename-tag` | Rename a tag throughout the entire vault (frontmatter and inline) |
| `set-frontmatter-field` | Set a single frontmatter field (not `tags`) to a scalar value, creating it if missing |
| `remove-frontmatter-field` | Remove a single frontmatter field (not `tags`) entirely |
| `query-graph` | Ask a natural-language question against a vault's graphify knowledge graph |

---

## How the obsidian-mcp-brain works

The server implements the [MCP Streamable HTTP transport (2024-11-05)](https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#streamable-http):

- **`POST /mcp`** — receives JSON-RPC requests from the client. `initialize` creates
  a session and returns server capabilities. Notifications return 202 code. All other
  requests are dispatched to the corresponding tool handler and the response is
  returned as an inline SSE event.

- **`GET /mcp`** — keeps a long-lived SSE stream open per session for server-to-client
  notifications (e.g. `tools/list_changed`).

All MCP tools are implemented natively in the server and operate directly on vault files
via `node:fs/promises`. Each tool resolves its `vault` argument against the configured
vaults and validates access control (that vault's effective deny list) before executing.

`resources/list` and `prompts/list` return empty results — the server does not expose
vault files as resources or prompts, only as tools.

---

## Security

The OAuth flow is intentionally public — there are no real credentials. Access control
relies on the network layer, so run the server on a private network, or an overlay
network such as Tailscale, not on the public internet.
The config file's `denyPaths` feature provides coarse-grained control over which
parts of a vault the MCP client can touch, but it is not a substitute for
network-level access control.

---

## Releasing

`obsidian-mcp-brain` publishes to npm via two tag-triggered GitHub Actions workflows
(`mcp-shim` is not published separately). To cut a release:

1. Go to the repo's **Actions** tab → **Tag a release** → **Run workflow**.
2. Leave the `version` input blank to auto-bump based on conventional-commit messages
   since the last tag (via [git-cliff](https://git-cliff.org)), or type an explicit
   version (`v1.2.0` or `1.2.0`).
3. That workflow bumps both `package.json` files (root and
   `obsidian-mcp-brain/package.json`), commits and tags (both GPG-signed), pushes,
   and triggers the `publish` workflow at the new tag.
4. `publish` runs the full test suite, publishes to npm with
   [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates
   a GitHub Release with a changelog generated from the commits since the last tag.

No manual `npm version` or `npm publish` step is needed — the workflow does both.

**Authentication**: publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC) — GitHub Actions authenticates directly via its own OIDC identity, with no
`NPM_TOKEN` or other long-lived secret involved. This is configured as a Trusted
Publisher on the package's npmjs.com settings (org `a1ecbr0wn`, repo
`obsidian-mcp-brain`, workflow filename `publish.yml`), with the "Allowed actions"
setting set to permit direct publish (Trusted Publisher configs default to
stage-only, which would otherwise leave every release pending manual approval on
npmjs.com).

**Before a package's very first-ever publish**: npm requires a live, interactive
one-time password for the first publish of any brand-new package name, regardless
of token type or OIDC — this is an anti-squatting safeguard with no CI workaround.
The first release of a new package must be published once manually from a local
machine (`npm publish --workspace=obsidian-mcp-brain --access public`, without
`--provenance`, which needs GitHub Actions' OIDC context and fails locally). Every
release after that can go through `tag.yml`/`publish.yml` unattended.

---

## mcp-shim

A lightweight shim that connects Claude Desktop to a remote MCP server over HTTPS
(Streamable HTTP transport). It relays Claude Desktop's stdio JSON-RPC protocol
to the remote server's HTTP+SSE interface.

### Requirements

Node.js 18 or later (no npm install needed — no dependencies).

### Configuration for Claude Desktop

Edit `claude_desktop_config.json` (find it via **Claude Desktop → Settings →
Developer → Edit Config**) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://my-server.example.com/mcp"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Environment Variables

| Variable      | Required | Default | Description                                                                                               |
| ------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `MCP_URL`     | Yes      | -       | HTTPS URL of the remote MCP endpoint (must be `https://`, not `http://`). Can also be passed as a positional argument: `node mcp-shim.mjs URL` |
| `MCP_TOKEN`   | No       | -       | Bearer token added to every request as `Authorization: Bearer TOKEN`                                      |
| `MCP_TIMEOUT` | No       | `60000` | Request timeout in milliseconds (POST and DELETE only — the SSE stream has no timeout)                    |

### Examples

#### Server with no auth

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/Users/alice/obsidian-mcp-brain/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://obsidian-mcp.example.com/mcp"
      }
    }
  }
}
```

#### Server with a bearer token

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["/Users/alice/obsidian-mcp-brain/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://api.example.com/mcp",
        "MCP_TOKEN": "sk-..."
      }
    }
  }
}
```

#### Custom timeout

```json
{
  "mcpServers": {
    "slow-server": {
      "command": "node",
      "args": ["/Users/alice/obsidian-mcp-brain/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://slow.example.com/mcp",
        "MCP_TIMEOUT": "30000"
      }
    }
  }
}
```

### How the mcp-shim works

1. Claude Desktop launches the shim as a subprocess and communicates over stdio.
2. The shim forwards each JSON-RPC message from Claude Desktop as an HTTPS POST
   to `MCP_URL`.
3. On the first response, it opens a persistent SSE GET stream on the same URL to
   receive server-initiated messages.
4. The SSE stream reconnects automatically with exponential backoff if it drops.
5. When Claude Desktop exits, the shim sends an HTTP DELETE to cleanly end the session.
