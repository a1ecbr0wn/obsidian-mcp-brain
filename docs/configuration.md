---
layout: docs
title: "Configuration | obsidian-mcp-brain"
nav_order: 3
---

## Configuration

All configuration lives in one JSON file. No environment variables are read
except `CONFIG_PATH`, which says where to find it.

- **Location**: the file named by `CONFIG_PATH` if that is set, otherwise
  `~/.config/obsidian-mcp.json`.
- The server reads and validates it once at startup. A missing file, invalid
  JSON or a failed validation logs a clear error and exits.
- One server process can serve several named vaults. A client picks which one a
  call applies to with the `vault` argument, which every tool except
  `list-vaults` and `get-setup-status` takes.

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
    "readNoteMaxChars": 50000,
    "uploadMaxBytes": 52428800,
    "uploadTtlSeconds": 300,
    "uploadStallSeconds": 30,
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

| Field                    | Required | Default                                                            | Description                                                                                                                                                                                                   |
| ------------------------ | -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpBaseUrl`             | Yes      | none                                                               | Public HTTPS base URL of the server (scheme, host and port, no path or trailing slash), used in OAuth responses, SSE endpoint events and upload URLs                                                          |
| `mcpPath`                | No       | `/mcp`                                                             | Path of the MCP endpoint, added to `mcpBaseUrl` to make the address clients connect to. Starts with `/`, no trailing slash, no spaces, empty segments, `.` or `..` segments, or `?` `#` `%` `\`               |
| `vaults`                 | Yes      | none                                                               | Non-empty object of `{ "name": { "path": "..." } }`. Each vault needs at least a `path`                                                                                                                       |
| `listenPort`             | No       | `3002`                                                             | Local port the server listens on                                                                                                                                                                              |
| `listenHost`             | No       | `127.0.0.1`                                                        | Address the server binds to. Leave it as loopback unless the server runs in a [container](install/install-docker), where `0.0.0.0` is needed for the published port to reach it                               |
| `denyPaths`              | No       | `[]`                                                               | Vault-relative paths to block, applied to every vault                                                                                                                                                         |
| `denyBinaryPaths`        | No       | `[]`                                                               | Vault-relative files or folders, with wildcards, whose binary files `read-binary-file` refuses to return. See [below](#binary-read-protection-denybinarypaths)                                                |
| `graphifyQueryTimeoutMs` | No       | `60000`                                                            | Timeout for a `graphify query` subprocess, in milliseconds                                                                                                                                                    |
| `fetchMaxBytes`          | No       | `10485760`                                                         | Default maximum response size for `fetch-binary-file`, in bytes; overridable per call                                                                                                                         |
| `fetchTimeoutMs`         | No       | `30000`                                                            | Default request timeout for `fetch-binary-file`, in milliseconds; overridable per call                                                                                                                        |
| `readMaxBytes`           | No       | `10485760`                                                         | Largest file `read-binary-file` will return, in bytes, measured on disk                                                                                                                                       |
| `readNoteMaxChars`       | No       | `50000`                                                            | Longest text `read-note` returns in one go, in characters. A longer note or section is refused with a pointer to `outline` and `heading`                                                                      |
| `uploadMaxBytes`         | No       | `52428800`                                                         | Largest file `upload-binary-file` will reserve an upload for, in bytes                                                                                                                                        |
| `uploadTtlSeconds`       | No       | `300`                                                              | How long an upload URL lasts, in seconds                                                                                                                                                                      |
| `uploadStallSeconds`     | No       | `30`                                                               | How long an upload may send nothing before it is cut off, in seconds. Raise it if clients on very slow links are cut off                                                                                      |
| `uploadTempDir`          | No       | `obsidian-mcp-uploads-<user id>` under the system temporary folder | Absolute path where uploads are held while being received. Must not be inside a vault, and must belong to the server's user. Created if missing                                                               |
| `trustedProxies`         | No       | `[]`                                                               | Addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For` header is believed. See [below](#uploads-and-reverse-proxies)                                                                             |
| `auth`                   | No       | none                                                               | Turns on authentication: the server accepts only signed tokens from an external OAuth service, for the users you list. Without it the server is unauthenticated, as before. See [below](#authentication-auth) |

Each vault entry can also set its own `denyPaths` and `denyBinaryPaths`, which
are added on top of the global lists for that vault only.

### Path deny list

`denyPaths` stops the MCP client reading or writing specific folders in a vault.
Paths are relative to the vault root and matched as prefixes, so denying
`people` blocks `people/`, `people/alice/notes.md`, and so on.

The top-level `denyPaths` applies to every vault. A vault's own `denyPaths` is
added on top of that global list, restricting that vault further without
affecting any other:

```json
{
    "denyPaths": ["private"],
    "vaults": {
        "knowledge": { "path": "/path/to/your/obsidian/vault" },
        "work": {
            "path": "/path/to/another/vault",
            "denyPaths": ["confidential", "drafts"]
        }
    }
}
```

Here both vaults block `private`, and `work` also blocks `confidential` and
`drafts`.

A blocked request gets a structured MCP error (`isError: true`) rather than a
transport failure, so the client can report the reason clearly. The check
happens before the tool reads or writes any file.

- **Refused when the path you give is denied:** `read-note`, `create-note`,
  `edit-note`, `delete-note`, `move-note` (source and destination),
  `create-binary-file`, `fetch-binary-file`, `read-binary-file`,
  `delete-binary-file`, `move-binary-file` (source and destination),
  `find-backlinks`, `resolve-wikilink`, `add-tags`, `remove-tags`,
  `set-frontmatter-field`, `remove-frontmatter-field`, `create-folder`, and
  `search-vault` when a `path` scope is given.
- **Filtered as they walk the vault:** `list-notes`, `list-tags`, `search-tags`,
  `new-notes`, `changed-notes` and `rename-tag` leave denied files out of their
  results.
- **Not affected:** `list-vaults` never touches vault files, and `query-graph`
  does not consult the deny list at all.

**`query-graph` can reveal denied content.** It answers from the vault's
graphify knowledge graph and never checks `denyPaths`. If the graph was built
over folders you have denied, its answers can include material from them. Build
the graph from a vault that does not contain the denied content, or leave
`query-graph` unused.

The deny list is a coarse guard on what a client can touch. It is not a
substitute for controlling who can reach the server; see [Security](security).

### Binary read protection (`denyBinaryPaths`)

`denyPaths` removes a path from every tool. `denyBinaryPaths` is narrower: it
stops the agent reading a binary file's _contents_ with `read-binary-file`,
while leaving the file in place and visible. The agent can still create, move
and delete such files, and `find-backlinks` still sees them. Use it for files
you want the agent to manage but not read, such as scanned documents.

Each entry is a vault-relative path, optionally with wildcards:

| Pattern | Meaning                                                            |
| ------- | ------------------------------------------------------------------ |
| `*`     | Any run of characters within one path segment (never across a `/`) |
| `?`     | Exactly one character within a segment                             |
| `**`    | As a whole segment, any number of segments, including none         |

Everything else is matched literally, and there are no character classes,
negation or brace expansion. Matching is case-sensitive, and `*` also matches
names that start with a dot. An entry protects a path it matches and everything
under a folder it matches, so:

| Entry         | Protects                                                 |
| ------------- | -------------------------------------------------------- |
| `scans`       | `scans/a.pdf`, `scans/2026/b.pdf`; not `scans-old/a.pdf` |
| `scans/*.pdf` | `scans/a.pdf`; not `scans/2026/a.pdf`                    |
| `*/scans`     | `a/scans/x.pdf`; not `scans/x.pdf` or `a/b/scans/x.pdf`  |
| `**/*.pdf`    | every PDF in the vault, at any depth                     |
| `private/**`  | everything under `private/`                              |

As with `denyPaths`, the top-level list applies to every vault and a vault's own
list is added to it. A refused read returns
`Reading is restricted for '<path>'`.

Protection only works if a protected file can't be relocated, so
`move-binary-file` refuses to move a protected file to a path that is not
protected, and the destination is judged by its final path. With `**/*.pdf` set,
renaming `scan.pdf` to `scan.txt` is refused as well. Moving a file between two
protected locations, or moving an unprotected file into a protected one, is
allowed.

The protection also closes the other routes to a protected file's content:

- **`.trash`** is protected automatically whenever any `denyBinaryPaths` are
  set, in that vault. A non-permanent `delete-binary-file` moves a file into
  `.trash`, so without this a protected file could be deleted and then read, or
  moved out, from there. The side effect is that nothing in `.trash` can be read
  with `read-binary-file` while the feature is on.
- **`read-note`** refuses a protected file that is not a `.md` file, since it
  would otherwise return an SVG, CSV or text-layer PDF as text. Markdown notes
  are never affected.
- **`move-note`** applies the same move rule as `move-binary-file` to a source
  that is not a `.md` file, so it can't be used to relocate a protected file.
- **`read-binary-file`** resolves symbolic links before checking. A link is
  judged by where it points: a link to a protected file is refused, and a link
  to a file outside the vault is refused outright.

Apart from those, `denyBinaryPaths` changes nothing: notes stay under
`denyPaths` alone. The other tools still judge a path as given and don't resolve
symbolic links. See [Security](security).

### Uploads and reverse proxies

[`upload-binary-file`](tools#upload-binary-file) hands out one-time upload URLs.
Three settings shape how they behave.

**`mcpBaseUrl`** is the address clients use to reach the server: scheme, host
and port, with no path and no trailing slash, such as `https://server:4001`.
Upload URLs are built from it (`https://server:4001/up/<random token>`). The
server can't work out its own address from a request, because behind a reverse
proxy the `Host` header it sees is usually the proxy's internal address. A
client that reaches the server at a different address from `mcpBaseUrl` can't
use the URL as given.

**`mcpPath`** is the path of the MCP endpoint. The address a client connects to
is `mcpBaseUrl` followed by `mcpPath`, `https://server:4001/mcp` by default. Set
it when the endpoint should be served at a different path, for example
`"/brain"`, so the connector address is `https://server:4001/brain`. It must
start with `/`, must not end with `/`, and must not contain spaces, empty
segments (`//`), `.` or `..` segments, or any of `?`, `#`, `%` and `\`. The
server refuses to start with a value that breaks those rules, or one that begins
with a path it uses for something else: `/up`, `/.well-known`, `/authorize`,
`/token` or `/register`. The MCP endpoint answers on that path only, and `/mcp`
answers `404` when another path is set. The protected resource metadata names
`mcpBaseUrl` followed by `mcpPath` as its `resource`, whatever
[`audience`](#authentication-auth) is, because clients compare it with the
address they connected to. A proxy or tunnel that adds a path in front of the
server still has to remove it before the request reaches the server.

**`uploadTempDir`** is where a file is held while it is being received, before
it has been checked. It defaults to an `obsidian-mcp-uploads-<user id>` folder
under the system's temporary folder (just `obsidian-mcp-uploads` where there are
no user ids), named for the user so that two users on one machine don't share
it. It must be an absolute path, and must not be inside a vault or contain one,
so that Obsidian or a sync tool never sees a half-received file.

At startup the server creates the folder with permissions only its user can use,
and checks it. A folder that belongs to another user is refused, and the server
stops with a message asking you to choose one with `uploadTempDir`: whoever owns
the folder could swap a file between its check and its placement. A folder of
yours that others can read or write is tightened to owner-only, and a note is
logged. A symbolic link at the default location is refused, since you never put
one there. If the default folder cannot be created at all, as in a container
with a read-only filesystem and no writable `/tmp`, the server still starts: it
logs that uploads are disabled, and only `upload-binary-file` refuses, saying
why. A folder you configure yourself that cannot be used stops the server,
because you asked for it. If you configure a folder that is a link, it is
resolved once at startup and the real folder is used from then on, so
re-pointing the link afterwards changes nothing. Leftovers from an earlier run
are removed, and only files this feature created are touched. Put it on disk
with enough room for `uploadMaxBytes` times the 4 uploads that can be in
progress.

The server's per-request time limit is raised, for every request, so that the
largest permitted upload can finish at 50 KB/s, up to a maximum of one hour
(Node's default is five minutes). An upload that sends nothing for
`uploadStallSeconds` (30 by default) is cut off regardless, with a `408` and the
staging file removed, so a client that connects, sends part of a file and goes
quiet cannot hold one of the 4 upload slots. The time is counted from the last
byte received, or from the `100 Continue` answer for a client that waited for
it. A proxy that buffers the whole body before forwarding it (nginx does by
default) hands the server a complete upload at once, so the server never sees a
slow client; it also means a refused upload is answered only after the whole
body has arrived. See [Putting HTTPS in front of the
server](install/#putting-https-in-front-of-the-server).

**`trustedProxies`** matters only if the server sits behind a reverse proxy
(nginx, Caddy, a tunnel, Tailscale Serve and so on). An upload URL works only
from the address that reserved it. Behind a proxy every connection comes from
the proxy, so unless the server is told otherwise, every caller looks the same
and that check always passes. List the proxy's address here and the server reads
the real caller from the `X-Forwarded-For` header the proxy adds (the
[nginx](install/install-nginx), [Caddy](install/install-caddy) and
[Tailscale](install/install-tailscale) pages show the proxy side):

```json
{ "trustedProxies": ["127.0.0.1", "::1"] }
```

Entries are single addresses or CIDR ranges such as `10.0.0.0/8`, for both IPv4
and IPv6. The header is believed only when the connection comes from one of
them, because anyone can send a forged one. When it does, the entries are read
from the right, skipping any that are themselves trusted proxies, and the first
remaining one is the caller. Typical values: `["127.0.0.1", "::1"]` for a proxy
on the same machine, or the range of the container network if the proxy runs in
Docker. If a request arrives with `X-Forwarded-For` from a connection that isn't
trusted, the server logs a hint once, which usually means this setting is
missing. If a trusted proxy sends a header the server can't read (an entry that
isn't an address, or one with a port), the caller can't be determined:
`upload-binary-file` refuses to reserve a URL, and an upload to an existing one
is refused.

The address check is a second line of defence. Callers behind the same NAT share
an address, so the real protection is the random token, which works once,
briefly, for one destination. See [Security](security#upload-binary-file).

### Authentication (`auth`)

Without an `auth` object the server is unauthenticated: anyone who can reach it
can use every tool, so it belongs on a private network. That is the default, and
it is the right setting for a server on a local network or behind a VPN.

Add an `auth` object when the server has to be reached from outside such a
network, for example by the Claude mobile app or claude.ai, whose connectors
call from the vendor's cloud. The server then runs as an OAuth _resource
server_: an OAuth service of your choosing logs the user in and issues signed
tokens, and this server checks them. It issues no tokens itself, shows no login
page and stores no passwords.

```json
{
    "mcpBaseUrl": "https://your-hostname",
    "auth": {
        "issuer": "https://auth.example.com",
        "jwksUri": "https://auth.example.com/.well-known/jwks.json",
        "audience": "https://your-hostname/mcp",
        "userClaim": "email",
        "users": ["you@example.com"],
        "readOnlyUsers": ["reader@example.com"]
    }
}
```

| Field           | Required | Default                 | Meaning                                                                                                                                                                                                                                                                             |
| --------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`        | Yes      |                         | The exact value a token's `iss` claim must have                                                                                                                                                                                                                                     |
| `jwksUri`       | Yes      |                         | Where the issuer's public signing keys are fetched from                                                                                                                                                                                                                             |
| `audience`      | No       | `<mcpBaseUrl><mcpPath>` | A value a token's `aud` claim must contain. It is the server's address as a client names it in the `resource` parameter of its authorization request, so the OAuth service must put the requested resource in `aud`                                                                 |
| `userClaim`     | No       | `sub`                   | The claim that identifies the user. `sub` is the safe choice. An `email` claim is compared without regard to ASCII case, and a token with `email_verified` set to false is refused, but only an issuer that verifies addresses before it issues them makes an email a safe identity |
| `users`         | Yes      |                         | Users who may call every tool. Must not be empty                                                                                                                                                                                                                                    |
| `readOnlyUsers` | No       | `[]`                    | Users who may call only the tools that read the vault                                                                                                                                                                                                                               |
| `tokenHeader`   | No       | `null`                  | A second header to read the token from, for a deployment where a fronting service passes the verified token on in its own header. When this header is present it is used; otherwise `Authorization: Bearer` is                                                                      |

What happens to a request to the MCP endpoint (`/mcp`, or your `mcpPath`):

- No token: `401` with a `WWW-Authenticate` header that points a client at the
  server's protected resource metadata, so a client that implements the MCP
  authorization flow can find the OAuth service and log in by itself.
- A token that fails a check (signature, issuer, audience, expiry): `401` with
  `error="invalid_token"`.
- A valid token for a user who is not listed: `403`.
- The issuer's keys cannot be fetched, and none are held: `503`, so a client
  does not start a new login for a fault that is not its own.
- Otherwise the request is served. Only signed tokens (RS256 and ES256) are
  accepted. Opaque tokens, which need a call to the issuer to check, are not
  supported; an OAuth service that issues them can be put in front of the server
  with a small Worker, as [the Cloudflare
  page](install/install-cloudflare-oauth) shows.

Notes:

- **The server starts only in a safe configuration.** It refuses to start when
  `auth` is set and `mcpBaseUrl` is not `https` (a loopback address is allowed,
  but then `listenHost` must be loopback too), when `users` is empty or a user
  is in both lists, or when `issuer` or `jwksUri` is not `https` (loopback
  allowed) or carries a user name or password. An unknown setting inside `auth`
  is an error, so is a top-level setting that looks like an authentication
  setting but is not named `auth`, so a misspelling cannot leave the server open
  without a word. Any other unknown top-level setting is reported and ignored.
- **What the OAuth service has to do.** For a client to sign in, the service
  must publish the standard discovery documents, accept the client's
  registration (dynamic client registration, or a client you register by hand),
  implement PKCE, and honour the `resource` parameter so that the token's `aud`
  is the `audience` above. Not every service does all of these by default. A
  client that cannot sign in is most often failing at one of them, and the
  server's log then shows `wrong audience` or no request at all.
- **`readOnlyUsers`** see and may call only the read tools: `list-notes`,
  `list-tags`, `search-tags`, `new-notes`, `changed-notes`, `list-vaults`,
  `get-setup-status`, `read-note`, `read-binary-file`, `find-backlinks`,
  `resolve-wikilink` and `search-vault`. Every tool that changes the vault,
  including `upload-binary-file` and `fetch-binary-file`, is refused with
  `This account is read-only`, and so is `query-graph`, because it ignores
  `denyPaths`.
- **A session belongs to the user who made it.** A request for that session with
  a token for another user is refused with `403`.
- **`PUT /up/<token>` and the discovery documents need no token.** An upload
  URL's one-time token is its credential, and an agent's sandbox has no OAuth
  token to present.
- **In this mode** `/authorize`, `/token`, `/register` and
  `/.well-known/oauth-authorization-server` answer `404`: they are the
  placeholder endpoints that make an unauthenticated server look as if it issues
  tokens.
- **Changing the user list takes a restart.** A token cannot be revoked before
  it expires, so use the issuer's setting for a short lifetime.

See [Security](security#authentication) for what this does and does not protect.
