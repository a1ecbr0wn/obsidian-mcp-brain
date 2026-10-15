---
layout: docs
title: "Expose it over HTTPS with Caddy | obsidian-mcp-brain"
---

## Expose it over HTTPS with Caddy

[Caddy](https://caddyserver.com) gets and renews a certificate by itself and forwards
to the server on the same machine. Unless you set
[`auth`](../configuration#authentication-auth), the server has no authentication, so decide who can
reach the proxy first; see [Security](../security). The proxy
behaviour below was tried against a running server (Caddy 2, plain HTTP on a local
port). The automatic certificate and `tls` lines were not exercised. With the
defaults, none of the behaviours that needed a setting in nginx came up.

### Configuration

The smallest `Caddyfile`:

```caddyfile
your-hostname {
    reverse_proxy 127.0.0.1:3002
}
```

That is all that is required. Caddy obtains a certificate for `your-hostname`
automatically, which needs the name to resolve to the machine and ports 80 and 443
to be reachable by the certificate authority. Replace the port with `listenPort`
(3002 by default). For a name that only your own network resolves, give Caddy a
certificate of your own with `tls /path/to/cert.pem /path/to/key.pem`, or use its
`tls internal`.

Set the server's [config file](../configuration) to match:

```json
{
  "mcpBaseUrl": "https://your-hostname",
  "trustedProxies": ["127.0.0.1", "::1"]
}
```

`trustedProxies` is the address Caddy connects from. Here Caddy runs on the same
machine, so that is loopback. If it runs somewhere else, or in another container,
use that address or its network range.

### What was checked

| Behaviour | Result |
|---|---|
| Request body size | Not limited by default, so a file at `uploadMaxBytes` (50 MiB) went through. Do not set `request_body { max_size }` below `uploadMaxBytes`: at 1 MB a 20 MB upload was refused at once with a `413` and no message |
| Real client address | Caddy adds `X-Forwarded-For` itself with the caller's address, so no header setting is needed. A request from a different address than the one that reserved the URL was refused with a `403` |
| `Expect: 100-continue` | Forwarded. `curl` shows two `100 Continue` lines, one from Caddy and one from the server, then `201 Created`. This is harmless |
| Request buffering | Caddy streams the body, so a refused upload is answered at once (0.1 s for a 20 MB body sent at 4 MB/s). nginx's default would take as long as the body |
| Streaming responses | Nothing to set. The server's responses and the notification stream pass through; `flush_interval` is not needed |
| Access log | With the `log` block below, the upload URL was logged as `/up/<redacted>` and the other requests unchanged |
| Timeouts | Caddy's documentation lists no default response timeout for `reverse_proxy`, so there is nothing equivalent to nginx's `proxy_read_timeout` to raise. The test held an idle notification stream open for four seconds only |

### Keep the upload token out of the access log

Caddy writes no access log unless you turn one on with `log`. If you do, the upload
URL, which contains the token, is recorded. Redact it:

```caddyfile
your-hostname {
    log {
        output file /var/log/caddy/brain.access.log
        format filter {
            wrap json
            request>uri regexp ^/up/[A-Za-z0-9_-]+ /up/<redacted>
        }
    }
    reverse_proxy 127.0.0.1:3002
}
```

The token is good for one request and expires, and the server redacts it in its
own log, but a log should not hold it. Caddy's JSON log also records request
headers; remove any you do not want to keep with another filter line.

### Check it

```sh
# 1. discovery (should return JSON)
curl https://your-hostname/.well-known/oauth-authorization-server

# 2. an MCP call: connect a client, and run list-vaults

# 3. an upload: ask the agent to put a file of several MB in the vault, or use the
#    upload-binary-file skill's script on a file over 1 MiB
```

If step 3 fails, see
[Putting HTTPS in front of the server](../install#putting-https-in-front-of-the-server).

Unless you set [`auth`](../configuration#authentication-auth), the server has no authentication, so where
Caddy is reachable from is what decides who can use your vault. Do not expose it to the
internet without it, or without other authentication in front. See
[Security](../security).
