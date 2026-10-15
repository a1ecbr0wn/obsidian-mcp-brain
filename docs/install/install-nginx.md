---
layout: docs
title: "Expose it over HTTPS with nginx | obsidian-mcp-brain"
---

## Expose it over HTTPS with nginx

nginx terminates TLS and forwards to the server on the same machine. Unless you set
[`auth`](../configuration#authentication-auth), the server has no authentication, so decide who can
reach the proxy first; see [Security](../security). The proxy settings below were tried against a running server
(nginx 1.31, without TLS), and the reason for each is given, because the defaults work
for small calls and fail for uploads. The TLS lines are the standard nginx pattern and
were not exercised.

### Configuration

`map` and `log_format` are valid only in the `http` context: put this in a file under
`conf.d/` (which nginx includes in `http`), or inside `http { }`.

```nginx
# Keep the one-time upload token out of the access log.
map $request_uri $loggable_uri {
    ~^/up/   /up/<redacted>;
    default  $request_uri;
}
log_format brain '$remote_addr "$request_method $loggable_uri" $status $body_bytes_sent';

server {
    listen 443 ssl;
    server_name your-hostname;

    ssl_certificate     /etc/letsencrypt/live/your-hostname/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-hostname/privkey.pem;

    access_log /var/log/nginx/brain.access.log brain;

    # At least uploadMaxBytes (50 MiB by default).
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 3600s;  # only needed for clients on very slow links
    }
}
```

Replace `your-hostname`, the certificate paths and the port (`listenPort`, 3002 by
default) with yours. TLS itself is ordinary nginx and independent of this server; a
certificate from Let's Encrypt (`certbot --nginx`) or your own both work.

Then set the server's [config file](../configuration) to match the proxy:

```json
{
  "mcpBaseUrl": "https://your-hostname",
  "trustedProxies": ["127.0.0.1", "::1"]
}
```

`trustedProxies` is the address nginx connects from. Here nginx runs on the same
machine, so that is loopback. If it runs somewhere else, or in another container, use
that address or its network range.

### What each setting is for

| Setting | Why |
|---|---|
| `client_max_body_size 64m` | nginx refuses a request body over 1 MiB by default, with its own HTML `413 Request Entity Too Large` page. Every upload larger than that fails, while MCP calls and small files work. Set it at least as high as `uploadMaxBytes`; `0` turns the limit off |
| `proxy_set_header X-Forwarded-For $remote_addr` | Gives the server the caller's real address, which the upload URL is bound to. `$remote_addr` replaces whatever the client sent; `trustedProxies` must list the address nginx connects from |
| `proxy_request_buffering off` | By default nginx receives the whole body, then forwards it. A refused upload is then answered only after the body has arrived: in a test, a 20 MB body to an upload that should be refused at once took 4.8 s at 4 MB/s, against 0.1 s with buffering off. A client on a slow link would wait for the whole file to be sent before it hears that the URL was wrong. With buffering off the server sees the body as it arrives, so `uploadStallSeconds` applies to a stalled client. Leaving it on works, and a buffering proxy holds the whole upload on its own disk first. With it off, nginx passes a chunked request on as chunked and the server answers `411` (it needs a `Content-Length`); `curl -T`, which the skill's script uses, sends one, and that case was not tried |
| `proxy_http_version 1.1` and `Connection ""` | HTTP/1.1 with keep-alive to the server, which is the configuration that was tried. `curl` sends `Expect: 100-continue` for any file over about 1 MiB; with these settings nginx forwards it and the interim `100 Continue` reaches `curl`. nginx's own default to a backend is HTTP/1.0, which was not tried |
| `proxy_buffering off` | Passes the server's responses on as they are written. The server sends a complete response to every call today, so the default also works, but the notification stream is a long-lived response and should not be held back |
| `proxy_read_timeout 3600s` | The notification stream (`GET /mcp`) is silent between messages. nginx closes a response that sends nothing for 60 seconds by default: in a test with the timeout at 3 s, the stream was closed after 3.0 s. Clients reconnect, but each drop is a failed request in the log. `proxy_send_timeout` is the limit between two writes from nginx to the server |
| `client_body_timeout 3600s` | The longest nginx waits between two reads of the request body from the client, 60 seconds by default. For an upload from a slow link this, and not the server's `uploadStallSeconds`, is the first limit reached. Not exercised in the test; it is nginx's documented default |
| `access_log` with the `map` | nginx's default log format records the whole request line, which for an upload is the URL with its token. The token is good for one request and expires, and the server redacts it in its own log, but a log should not hold it |

### Check it

```sh
# 1. discovery (should return JSON)
curl https://your-hostname/.well-known/oauth-authorization-server

# 2. an MCP call: connect a client, and run list-vaults

# 3. an upload: ask the agent to put a file of several MB in the vault, or use the
#    upload-binary-file skill's script on a file over 1 MiB
```

If step 3 fails, see
[Putting HTTPS in front of the server](../install#putting-https-in-front-of-the-server)
for what each symptom means. Setting `trustedProxies` right can also be checked in
the server's log: it says when a request carried `X-Forwarded-For` from an address
that is not trusted.

Unless you set [`auth`](../configuration#authentication-auth), the server has no authentication, so where
nginx is reachable from is what decides who can use your vault. Do not expose it to the
internet without it, or without other authentication in front. See
[Security](../security).
