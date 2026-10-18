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
    "uploadNetworkPrefix": 0,
    "logFile": "/var/log/obsidian-mcp.log",
    "sessionTimeoutSeconds": 1800,
    "trashRetentionDays": 30,
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
| `uploadNetworkPrefix`    | No       | `0`                                                                | Whether an upload must come from the address that reserved its URL: `0` for no check, or the leading bits of an IPv4 address that must agree, 16 to 32. See below                                             |
| `trustedProxies`         | No       | `[]`                                                               | Addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For` header is believed. See [below](#uploads-and-reverse-proxies)                                                                             |
| `logFile`                | No       | `none`                                                             | Absolute path of a file to append the log to, as well as the console. Includes the audit log. See [Logging](#logging-and-the-audit-log)                                                                       |
| `sessionTimeoutSeconds`  | No       | `1800`                                                             | How long a session may be idle before it is removed, in seconds (at least 60). See [Sessions](#sessions)                                                                                                      |
| `trashRetentionDays`     | No       | `30`                                                               | Days a file stays in `.trash` before the server deletes it for good; `0` keeps files. See [Emptying `.trash`](#emptying-trash)                                                                                |
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
  moved out, from there. The side effect is that no file in `.trash` other than
  a `.md` note can be read with `read-binary-file` while the feature is on.
- **`read-note`** refuses a protected file that is not a `.md` file, since it
  would otherwise return an SVG, CSV or text-layer PDF as text. Markdown notes
  are never affected.
- **`move-note`** applies the same move rule as `move-binary-file` to a source
  that is not a `.md` file, so it can't be used to relocate a protected file. It
  also refuses to rename a protected file to a `.md` name, because a note is
  not protected and `read-binary-file` would then return it.
- **`read-binary-file`** resolves symbolic links before checking. A link is
  judged by where it points: a link to a protected file is refused, and a link
  to a file outside the vault is refused outright. It returns a `.md` file
  whatever the patterns say, as `read-note` does (`denyPaths` still applies),
  and judges a `.md` link by its target.

Apart from those, `denyBinaryPaths` changes nothing: notes, however they are
read, stay under `denyPaths` alone. The other tools still judge a path as given
and don't resolve symbolic links. See [Security](security).

### Uploads and reverse proxies

[`upload-binary-file`](tools#upload-binary-file) hands out one-time upload URLs.
Several settings shape how they behave.

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

**`uploadNetworkPrefix`** decides whether an upload must come from the same
place as the call that reserved its URL. The default, `0`, means no check: any
address may use the URL. That is what a client needs when its tool call and its
`curl` leave from unrelated networks, which is how Claude Code works through the
claude.ai connector (the call comes from the vendor's cloud and `curl` runs on
your own machine) and how Claude Desktop chat and claude.ai work (the call comes
from the vendor's cloud and `curl` runs in a sandbox).

Set it to require the caller to match. `32` means the same address. A number
from 16 to 31 accepts any IPv4 address that shares that many leading bits: with
`21`, `160.79.106.186` and `160.79.109.20` match, because they are both in
`160.79.104.0/21`, and `160.79.112.20` does not. IPv6 addresses always have to
match exactly. Anything else is refused at start-up, so the setting can't be
made wide enough to defeat the check by mistake.

With the check off, the protection of an upload URL is the URL itself: a random
token that works once, for `uploadTtlSeconds`, for one destination that must not
exist, and a file that must match the size and SHA-256 declared when it was
reserved. Someone who gets the URL can only upload those exact bytes or use the
URL up. The audit log records both ends of every placed upload: `addr` is where
the upload came from and `reserved_from` is where the call came from. When the
check is on, set `trustedProxies` too behind a reverse proxy, so the address that
is compared is the caller's and not the proxy's.

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
(nginx, Caddy, a tunnel, Tailscale Serve and so on). Behind a proxy every
connection comes from the proxy, so unless the server is told otherwise, every
caller looks the same: the address in the log is the proxy's, and an
`uploadNetworkPrefix` check, if you use one, always passes. List the proxy's
address here and the server reads the real caller from the `X-Forwarded-For`
header the proxy adds (the
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
isn't an address, or one with a port), the caller can't be determined. With
`uploadNetworkPrefix` above 0, `upload-binary-file` then refuses to reserve a
URL, and an upload to an existing one is refused. With the default (`0`) no
address is needed: the upload goes ahead and the audit log records the address
as `unknown`.

The address check is off by default, and when it is on it is only a second line
of defence. Callers behind the same NAT share an address, so the real protection
is the random token, which works once, briefly, for one destination, with a file
that must match the declared hash. See
[Security](security#upload-binary-file).

### Sessions

A client opens a session with `initialize` and names it with `Mcp-Session-Id`
on every later request. The server keeps at most 1000 sessions, and a client
that starts, reconnects after a `404` or restarts opens a new one each time, so
an unused session has to go or the table fills and every new `initialize` is
answered `503 session table full`.

**`sessionTimeoutSeconds`** is how long a session may be idle before the server
removes it: a whole number of at least 60, 1800 (30 minutes) by default. A
session is idle while no request is being handled and no notification stream
(`GET /mcp`) is open. A request that ends, and a stream that opens or closes,
restart the time, and an open stream or a running request keeps the session for
as long as it lasts. The server checks every 15 seconds, so a session goes up to
15 seconds after the time is up. The next request with its id is answered
`404`, which MCP clients take as the cue to start a new session; with `auth` on
no new sign-in is needed, because the token is checked on every request. A
session that has no stream open a minute after it was made is removed too,
whatever it is doing.

A client can end its session sooner with `DELETE /mcp`: the server removes the
session, closes its stream and answers `204`. A session it doesn't know gets
`404`. With `auth` on the request needs a valid token for the session's user,
as any other request does.

### Emptying `.trash`

The server moves what it deletes to the vault's `.trash` folder: `delete-note`,
`delete-binary-file`, and the old version of a file that `replace-binary-file`
replaces. Each file is named `<name>_<epoch milliseconds><extension>`, such as
`report_1760812345678.pdf`, so the name says when it was trashed and files of
the same name never collide (a very long name is shortened to fit). A file can
be restored with `move-binary-file` or `move-note`.

**`trashRetentionDays`** is how long a file may stay there before the server
deletes it for good: a whole number of days, 30 by default, and `0` to keep
everything for ever. Any other value stops the server at start-up. A vault can
set its own value next to its `path`, which wins over the server-wide one:

```json
{ "trashRetentionDays": 30, "vaults": { "work": { "path": "/data/work", "trashRetentionDays": 90 } } }
```

The server empties `.trash` once, shortly after it starts, and then every 24
hours. It deletes every regular file in `.trash` older than the limit,
**including what Obsidian or you put there**, and the folders that this leaves
empty or that are empty and older than the limit (never `.trash` itself). A
deleted file is not recoverable.

A file's age is the time since its change time (`ctime`), which the filesystem
sets when the file is moved into `.trash`. The time in a file's name is for
people and is not used: a name can be anything, so a name that claims a file is
old cannot make a new file old. The modification time is not used either, since
it is when the content was last edited, and a file edited a year ago and deleted
today is not purged at once. A file inside a folder that was moved into `.trash`
counts as old only when its folder is too, so trashing a whole folder does not
expose its files to the next purge. Something that changes a file's `ctime`
later, such as a backup tool restoring it, only delays its deletion. A file
whose age cannot be worked out is kept.

The purge never leaves `.trash`: it refuses a `.trash` that is a symbolic link
(so do the tools that move files into it), does not follow links inside it (a
link is removed as a link), checks before each folder is read and each file is
removed that no folder on the way has been swapped for a link, and ignores
`denyPaths`, because it only deletes. That check cannot close the few
microseconds between the check and the removal, in which another process with
write access to your vault could swap a folder for a link. A file that vanishes
during the run is not an error, and a file that cannot be deleted is logged and
counted while the run goes on.

Every run writes a line to the log for each vault, such as
`trash purge of work: 3 file(s) older than 30 day(s) removed`. Every file
removed is written to the [audit log](#logging-and-the-audit-log) as
`AUDIT event=trash-purged vault=… path=… bytes=… age_days=…`, and a run that
removed or failed on anything adds `AUDIT event=trash-purge vault=… files=…
bytes=… errors=…`. Files already in `.trash` when you upgrade keep their names
and are purged by the same rule. If two vault names share a folder, the
shorter limit applies to its `.trash`.

### Logging and the audit log

The server writes its log to the console: standard output, and standard error
for errors. A service manager such as systemd keeps it, and `journalctl` shows
it.

**`logFile`** also appends every log line to a file. Set it to an absolute path
in a folder that exists. The file is created readable by its owner only, and an
existing file that others can read is made owner-only, with a note in the log.
The server stops at startup if it can't open the file, so an audit log is never
silently missing. Nothing is logged to the file that is not also on the
console. The server doesn't rotate the file; use `logrotate`, which can either
copy and truncate the file or move it and signal the server:

```text
/var/log/obsidian-mcp.log {
    weekly
    rotate 8
    compress
    missingok
    postrotate
        systemctl kill --signal=HUP obsidian-mcp.service
    endscript
}
```

On `SIGHUP` the server closes the file and opens the path again, so a moved file
is replaced by a new one. With `copytruncate` instead of `postrotate` no signal
is needed, because the file is opened for appending.

On `SIGTERM` and `SIGINT` the server logs a `stop` event and exits with
status 0. With `logFile` set the server also takes `SIGHUP` as the signal to
reopen the file, so a hangup from a terminal no longer ends it.

The file is written synchronously, a line at a time, so a disk that stalls
(a network mount, for example) stalls the server too. A write that fails is
reported once on standard error and the line is lost; the console still has it.

**The audit log** is the lines that start `AUDIT` after the timestamp, in the
same stream, so `grep AUDIT` separates them:

```text
2026-10-16T18:20:11.456Z AUDIT event=login user=alec@example.com addr=203.0.113.7 host=brain.example.com sid=1f3c9a2e role=full
2026-10-16T18:20:12.002Z AUDIT event=tool user=alec@example.com addr=203.0.113.7 host=brain.example.com sid=1f3c9a2e tool=read-note vault=knowledge filename=todo.md
2026-10-16T18:20:12.010Z AUDIT event=tool-result user=alec@example.com addr=203.0.113.7 host=brain.example.com sid=1f3c9a2e tool=read-note vault=knowledge filename=todo.md outcome=ok duration=8
```

Every line has `event=<name>` first and then `key=value` pairs. A value
contains no spaces, only printable ASCII, and at most 100 characters, so it
can't add a field or a line. The events are:

| Event | When | Fields besides `user`, `addr`, `host` and `sid` |
| --- | --- | --- |
| `start` | The server starts listening | `version`, `listen`, `auth` (`on` or `off`), `logfile` (`yes` or `no`) |
| `stop` | The server is stopped with `SIGTERM` or `SIGINT` | `signal` |
| `login` | A client opens a session | `role` (`full` or `readonly`), with authentication on |
| `login-refused` | A token is missing or refused | `reason`; `user` when the token names one |
| `session-refused` | A session is used by another user | `reason` |
| `session-end` | A client ends its session with `DELETE /mcp` | none |
| `session-expired` | A session is removed by the server | `reason` (`idle`, with `idle` in seconds, or `no_stream`) |
| `tool` | Every tool call, including reads | `tool`, and the arguments listed below |
| `tool-result` | The call has ended | `tool`, the same arguments, `outcome` (`ok`, `error`, or `aborted` when the client went away before the answer), `duration` in milliseconds |
| `denied` | The call is refused by the read-only role, `denyPaths` or `denyBinaryPaths`, in place of `tool-result` | `tool`, the same arguments, `reason` |
| `upload-reserved` | `upload-binary-file` reserves a URL | `vault`, `path`, `size` |
| `upload-placed` | An upload has been checked and placed | `vault`, `path`, `bytes`, `sha256`; `user` is who reserved it |

`user` is the signed-in user, or `-` when authentication is off. `addr` is the
caller's address, worked out the way
[`trustedProxies`](#uploads-and-reverse-proxies) says. `host` is the `Host`
header, or, for a connection from a trusted proxy, the last entry of
`X-Forwarded-Host`. `sid` is the first part of the session id.

A tool call logs only these arguments: `vault`, `folder`, `filename`,
`newFolder`, `newFilename`, `path`, `tags`, `oldTag`, `newTag`, `field`,
`heading`, `target`, `url` (scheme, host and path only: no credentials, query
string or fragment) and `permanent`, plus the
`size` of an upload. The audit log never holds a token, an upload URL, the text
of a note, a search query or any other argument, and none of them is logged
anywhere else. An upload refused for any reason is logged as `upload refused
(<status>) from <address> host=<host>: <reason>`, and a request for an upload
URL is logged with its address and host, with the token replaced by
`<redacted>`.

An unexpected error is logged with its stack, which takes several lines.

The log names users and paths, so keep the file and its backups where only the
people who should see them can.

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
