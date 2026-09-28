---
layout: docs
title: "Installation | obsidian-mcp-brain"
nav_order: 2
has_children: true
---

## Installation

The server needs Node.js 18 or later. Install it from npm, write a
[config file](../configuration), then run it as a service and put HTTPS in front
of it.

- [Install from npm](install-npm)
- Linux - [Run as a systemd service](install-systemd)
- macOS - [Run as a launchd agent](install-launchd)
- [Expose it over HTTPS with Tailscale Serve](install-tailscale)

### Optional: `query-graph`

The `query-graph` tool asks a natural-language question against a vault's
knowledge graph. It needs the `graphify` CLI installed and on `PATH`, and a graph
already built for that vault (run `graphify --obsidian` against it once). The tool
is always listed; calling it on a vault with no graph returns a clear error rather
than an answer.
