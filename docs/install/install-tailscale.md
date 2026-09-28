---
layout: docs
title: "Expose it over HTTPS with Tailscale Serve | obsidian-mcp-brain"
---

## Expose it over HTTPS with Tailscale Serve

Remote MCP clients need an HTTPS URL, and the server has no authentication of its
own, so it should only be reachable over a private network, or an overlay network
such as Tailscale. [Tailscale Serve](https://tailscale.com/kb/1312/serve) does both
jobs: it provides the HTTPS endpoint and limits who can reach it to the devices on
your tailnet. A private network plus an HTTPS reverse proxy works too.

Point Tailscale at the server's local port:

```sh
sudo tailscale serve --bg --https 4001 http://localhost:3002
```

This exposes the server at `https://<your-tailscale-hostname>:4001`. Put that
address in the `mcpBaseUrl` field of your [config file](../configuration), and use
`https://<your-tailscale-hostname>:4001/mcp` as the URL when you
[connect a client](../connect).

The server's OAuth flow is deliberately public, so this network layer is what
controls access. See [Security](../security).
