---
layout: docs
title: "Installation | obsidian-mcp-brain"
nav_order: 2
has_children: true
---

## Installation

The server needs Node.js 18 or later, or a container runtime if you'd rather use
the Docker image. Either way, write a [config file](../configuration), then run
it as a service and put HTTPS in front of it.

- [Install from npm](install/install-npm)
- [Run it in Docker](install/install-docker)
- Linux - [Run as a systemd service](install/install-systemd)
- macOS - [Run as a launchd agent](install/install-launchd)
- [Expose it over HTTPS with Tailscale Serve](install/install-tailscale)
- [Expose it over HTTPS with nginx](install/install-nginx)
- [Expose it over HTTPS with Caddy](install/install-caddy)
- [Protect it with Cloudflare Tunnel and
  Access](install/install-cloudflare-access)
- [Sign in with Cloudflare's
  workers-oauth-provider](install/install-cloudflare-oauth)

### Putting HTTPS in front of the server

Remote clients need an HTTPS URL, so almost every install needs something in
front of the server. The three pages above each give a complete setup. What the
server needs from whichever you use:

| | Tailscale Serve | nginx | Caddy |
| --- | --- | --- | --- |
| HTTPS certificate | Issued by Tailscale (MagicDNS and HTTPS enabled) | Yours, for example Let's Encrypt | Automatic |
| Who can reach it | Your tailnet only | Wherever nginx listens | Wherever Caddy listens |
| Upload size | No limit | Raise `client_max_body_size` to at least `uploadMaxBytes` | No limit by default |
| Real caller's address | Sent as `X-Forwarded-For` | Set `X-Forwarded-For $remote_addr` | Sent as `X-Forwarded-For` |
| `trustedProxies` | `["127.0.0.1", "::1"]` | The address nginx connects from | The address Caddy connects from |
| Request body buffering | Not checked | On by default; set `proxy_request_buffering off` | None |
| Idle notification stream | Not checked | `proxy_read_timeout` closes it at 60 s by default | Left open |
| Upload token in the access log | Not checked | Logged by default; redact it | Not logged unless `log` is on; redact it |

Whichever you use, `mcpBaseUrl` has to be the address clients use. Unless you
set [`auth`](../configuration#authentication-auth), the server has no
authentication of its own, so where the proxy is reachable from is what decides
who can use your vault. See [Security](../security).

With `auth` set the proxy needs nothing extra: it passes `Authorization` through
(nginx and Caddy both do by default), `/mcp` then needs a token, and
`PUT /up/<token>` and the discovery documents stay open. If you publish the
server on a public address, set `auth` first. The server refuses to start with
`auth` on and a plain `http` `mcpBaseUrl` that is not loopback, so TLS is the
proxy's job.

#### When something is wrong

| Symptom | Likely cause |
| --- | --- |
| Calls and small files work, larger uploads fail with a `413` (an HTML page from nginx, an empty body from Caddy) | The proxy's body-size limit. For nginx, `client_max_body_size`; for Caddy, a `request_body` limit |
| The upload is refused with `403` | The upload came from a different address from the one that made the `upload-binary-file` call, for example an agent whose shell runs on another machine or in a vendor's cloud, or one that reaches the server by a different route from its MCP connection. The server accepts any address unless `uploadNetworkPrefix` is set, so this means it is set; the server's log says which two addresses it compared |
| `uploadNetworkPrefix` is set, but the address check does not stop anything | `trustedProxies` does not list the address the proxy connects from, so every caller looks like the proxy and the check always passes. The server's log says when a request carried `X-Forwarded-For` from an address it does not trust |
| The URL in the `upload-binary-file` result has the wrong host or scheme | `mcpBaseUrl` is not the address clients use. Change it and restart the server |
| A refused upload takes as long as the whole file to report | The proxy buffers the request body. Turn it off (nginx: `proxy_request_buffering off`) |
| Clients connect and then drop at a regular interval | An idle timeout on the proxy closing the notification stream (nginx: `proxy_read_timeout`) |
| An upload is cut off with `408 upload stalled` | The client sent nothing for `uploadStallSeconds` (30 by default). Raise it if clients are on very slow links |
| An upload fails from a client that cannot reach the address in the URL | The URL is built from `mcpBaseUrl`, so a client that reaches the server at a different address cannot use it |

### Optional: `query-graph`

The `query-graph` tool asks a natural-language question against a vault's
knowledge graph. It needs the `graphify` CLI installed and on `PATH`, and a
graph already built for that vault (run `graphify --obsidian` against it once).
The tool is always listed; calling it on a vault with no graph returns a clear
error rather than an answer. The Docker image does not include `graphify`, so
use a native install if you need this tool.
