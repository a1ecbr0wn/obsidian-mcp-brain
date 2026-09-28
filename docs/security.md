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

### Reporting a problem

If you think you have found a security problem, please raise it through
[GitHub issues](https://github.com/a1ecbr0wn/obsidian-mcp-brain/issues). Describe
the problem without including a working exploit.
