---
layout: docs
title: "Security | obsidian-mcp-brain"
nav_order: 6
---

## Security

### Who can reach the server

The OAuth flow is deliberately public: it exists so that Claude Code's discovery
handshake completes, and there are no real credentials behind it. Anyone who can
reach the server's address can use every tool it exposes, so access control has to
come from the network layer. Do not expose the server to the public internet.
Run it on a private network, or an overlay network such as
[Tailscale](install/install-tailscale), so that only devices you trust can reach
it.

Treat the server as having the same reach as its most permissive vault: whatever
the process user can read and write in a configured vault, a connected client can
too.

### Limiting what a client can touch

The config file's [`denyPaths`](configuration#path-deny-list) blocks specific
folders, globally or per vault, and is enforced in the server before a tool touches
any file. It is a coarse guard, not a substitute for network access control, and
it has one exception: `query-graph` answers from a graphify knowledge graph without
consulting the deny list, so a graph built over denied folders can reveal their
content. Build the graph from a vault without that content, or don't use the tool.

[`denyBinaryPaths`](configuration#binary-read-protection-denybinarypaths) is a
narrower, read-only guard for binary files. It stops `read-binary-file` returning a
protected file's bytes, and stops `move-binary-file` (and `move-note`, for a
non-markdown file) moving a protected file out of protection, so the agent can't
relocate a file to read it. `.trash` is protected along with it, and `read-note`
refuses a protected non-markdown file. It doesn't affect markdown notes.

Symbolic links are handled differently by different tools. `read-binary-file`
resolves a link and checks the real location: it refuses a link that points outside
the vault, and applies `denyPaths` and `denyBinaryPaths` to the target. The other
tools, including `read-note`, judge a path as the client gives it and read through a
link. If the process user can read the target, a connected client can read it with
`read-note` by way of a symlink in the vault, whatever the deny lists say. Don't put
symlinks to sensitive files inside a served vault.

Other protections that apply to every request:

- `redirect_uri` in the OAuth flow is restricted to loopback addresses, to prevent
  open-redirect abuse.
- The `Origin` header is checked against loopback, to prevent DNS-rebinding attacks
  on the local port.
- Errors are returned as MCP `isError` results, with the vault's path prefix
  removed from the message. Other absolute paths that appear in an error, such as
  output from an external command, are not rewritten.
- Writes can carry an [`expectedMtime`](tools#avoiding-overwrites-with-expectedmtime)
  precondition so an edit never silently overwrites a change made in between.

### `fetch-binary-file`

This tool makes the server perform an outbound request to a URL chosen by the
caller. On any deployment, the host it runs on may be able to reach private network
services that a remote client should never be able to reach. Treating that as the
main risk, the tool:

- accepts only `http` and `https` URLs;
- resolves the hostname and refuses the request if **any** resolved address is not
  a public one: "this network", loopback, link-local (including the cloud metadata
  address), RFC1918, carrier-grade NAT, IETF-protocol, benchmarking, documentation,
  multicast and reserved ranges for IPv4; and loopback, unspecified,
  IPv4-compatible, discard-only, unique-local, link-local, site-local, multicast,
  Teredo, 6to4, NAT64 and documentation ranges for IPv6. An
  IPv4-mapped IPv6 address such as `::ffff:127.0.0.1` is unwrapped and checked as
  the IPv4 address it contains, in either notation;
- treats anything that isn't a well-formed address as blocked;
- follows at most 5 redirects and re-checks every hop the same way, since a public
  hostname can redirect to a private address;
- connects to the exact address it validated rather than resolving the hostname a
  second time, so a hostname can't pass the check and then rebind to a private
  address;
- counts the response size while it streams and aborts as soon as it passes
  `maxBytes`;
- applies a hard timeout to each hop, including its DNS resolution, so a fetch that
  follows redirects can take up to about six times `timeoutMs` in total;
- checks the destination path against the deny list and for collisions before
  making any network request, so a denied or occupied path never causes one.

### `read-binary-file`

This tool is read-only and makes no network request or subprocess call. It checks
the path against `denyPaths` and `denyBinaryPaths` before any filesystem access, and
checks the file's size against `readMaxBytes` using `stat` before reading it, so an
oversized or protected file is never loaded into memory. Symbolic links are resolved
first, and only regular files are returned. The `denyBinaryPaths` matcher runs in
time bounded by the pattern and path lengths, so a client can't slow the server with
a crafted path. The size limit matters
because the whole file is base64-encoded into one response, which is a third larger
than the file itself.

### `upload-binary-file`

This tool reserves a one-time URL, and a file sent to it ends up in the vault, so the
URL has to be hard to misuse. It is built like this:

- The token in the URL is 256 random bits. The server keeps only a hash of it, so what
  it holds in memory can't be turned back into a working URL, and reservations are lost
  when it restarts.
- A reservation is used up by the first request that names it, whatever that request is,
  and expires after `uploadTtlSeconds`. A person who has seen a URL therefore gets one
  attempt, not several. The cost is that they can make the agent's upload fail once, and
  the agent recovers by asking for a new URL.
- The destination, size and hash are fixed when the URL is reserved. The upload request
  can't change them, and it carries no filename or path of its own.
- The deny rules and the no-overwrite rule are checked when the URL is reserved and
  again when the file is placed. A file that doesn't match the declared size and SHA-256
  is deleted, never placed.
- Symbolic links in the destination are followed before those checks, at both points. A
  link inside the vault that points outside it, or into a denied folder, is refused, so an
  upload can't be used to write outside the vault. (`create-binary-file` does not do this.)
- The file is copied to a hidden temporary name beside its destination, its hash checked
  again, and then linked to its real name, so the real name never shows a half-written
  file and an existing file is never overwritten. It gets the permissions any new file
  would get, not the private ones used while staging.
- Requests carrying an `Origin` header are refused, so a web page can't use a URL.
- The file is held outside every vault until it has been verified, with permissions only
  the server's user can use. The staging folder is checked at startup: it must not be
  inside a vault, it must belong to the server's user (otherwise someone else could swap a
  file between its check and its placement), and if others could read or write it, it is
  tightened to owner-only.
- At most 16 URLs can be pending and 4 uploads in progress, and an upload that sends
  nothing for 30 seconds is cut off, so one client can't fill the disk or exhaust the
  server's file handles. One trade-off: Node's whole-request time limit can't be set per
  request, so the server raises it for every request, enough for the largest permitted
  upload to finish at 50 KB/s and never beyond an hour. That makes a slow client on any
  endpoint hold a connection longer than the default five minutes.
- The server's log never contains the token or the URL; an upload request is logged as
  `/up/<redacted>`.

What it doesn't do: it is not authentication. The server has no real credentials (see
[Who can reach the server](#who-can-reach-the-server)), so anyone who can call its tools
can reserve a URL. The token limits one upload to one destination; it doesn't decide who
may upload. The URL also appears in the tool's result, so it is visible to the model and
in the conversation transcript, which is why it is short-lived and works only once.

The address check (the upload must come from the address that reserved it) adds a
little: callers behind the same NAT share an address, and behind a reverse proxy the
check does nothing unless [`trustedProxies`](configuration#uploads-and-reverse-proxies)
is set. Set it only to proxies you run, because the `X-Forwarded-For` header from
anywhere else is ignored; if the server can be reached directly as well as through the
proxy, a forged header would otherwise defeat the check.

### Reporting a problem

If you think you have found a security problem, please raise it through
[GitHub issues](https://github.com/a1ecbr0wn/obsidian-mcp-brain/issues). Describe
the problem without including a working exploit.
