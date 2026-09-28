---
layout: docs
title: "Remote MCP access to an Obsidian vault | obsidian-mcp-brain"
nav_order: 1
permalink: /
---
<!-- markdownlint-configure-file {
  "MD033": false,
  "MD041": false
} -->

`obsidian-mcp-brain` is a thin Node.js HTTP server that gives remote MCP clients,
such as Claude Code and Claude Desktop, access to one or more Obsidian vaults. It
implements every tool natively and reads and writes the vault files directly.

## Why it exists

Remote MCP clients connect over HTTP, not stdio, and the usual approaches have
problems:

- **No HTTP transport for local MCP servers.** Wrapping a stdio MCP server with a
  proxy such as [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) can leave
  `tools/list` timing out: Claude Code opens its `GET /mcp` notification stream at
  the same moment it asks for the tool list, and the proxy's response routing gets
  confused. This server implements the MCP HTTP transport directly and has no
  child process.
- **No OAuth 2.0 discovery.** The MCP spec requires every non-localhost remote
  server to expose OAuth 2.0 discovery endpoints, and Claude Code refuses to
  connect without them. This server serves a public, no-credentials OAuth flow so
  the handshake completes.

## How it fits together

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

## Where to go next

- [Install](install) the server and run it as a service
- [Configure](configuration) your vaults and access rules
- [Connect a client](connect) such as Claude Code or Claude Desktop
- Browse the [tools](tools) it exposes
- Read about the [security model](security) before exposing it on a network
