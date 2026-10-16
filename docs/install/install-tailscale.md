---
layout: docs
title: "Expose it over HTTPS with Tailscale Serve | obsidian-mcp-brain"
---

## Expose it over HTTPS with Tailscale Serve

Remote MCP clients need an HTTPS URL, and a server without
[`auth`](../configuration#authentication-auth) set has no authentication, so it
should only be reachable over a private network, or an overlay network such as
Tailscale. [Tailscale
Serve](https://tailscale.com/docs/features/tailscale-serve) does both jobs: it
provides the HTTPS endpoint and limits who can reach it to the devices on your
tailnet. A private network plus an HTTPS reverse proxy works too: see
[nginx](install-nginx) and [Caddy](install-caddy).

### Before you start

Serve's HTTPS needs two things switched on for your tailnet in the Tailscale
admin console (**DNS** page): MagicDNS and HTTPS certificates. Without them
`tailscale serve --https` fails, and the error does not say why. Tailscale's
page on [enabling HTTPS](https://tailscale.com/kb/1153/enabling-https) has the
steps. Every device that will connect must be on your tailnet, or have the
machine shared with it.

### Find the machine's name

The URL uses the machine's full name, which has the form
`<machine>.<tailnet>.ts.net`. To see it:

```sh
tailscale status --json | grep -m1 '"DNSName"'
```

The first `DNSName` is this machine's, with a trailing dot that is not part of
the name. `tailscale status` lists the other machines on the tailnet, and the
admin console's **Machines** page shows the same names. The name has to be one
that Tailscale can issue a certificate for, which is what `CertDomains` in
`tailscale status --json` lists.

### Start Serve

Point it at the server's local port (3002 unless you changed `listenPort`):

```sh
sudo tailscale serve --bg --https 4001 http://localhost:3002
```

- `--https 4001` is the port clients use. Leave it out to use 443.
- `--bg` keeps it running after the command returns, and Tailscale keeps the
  setting across reboots, so there is nothing to put in a service file.
- `sudo` is needed unless you have made yourself the Tailscale operator
  (`sudo tailscale set --operator=$USER`).

Check it:

```sh
tailscale serve status
```

For example (the exact text can differ between Tailscale versions):

```text
https://your-machine.your-tailnet.ts.net:4001 (tailnet only)
|-- / proxy http://localhost:3002
```

To stop serving everything on this machine, run `tailscale serve reset`. That
removes every Serve setting, not only this one, so check
`tailscale serve status` first if the machine serves anything else.

### Tell the server its address

Put the name and port from the URL in the `mcpBaseUrl` field of your [config
file](../configuration), and tell the server to believe the address Serve
reports, which is what makes upload URLs work (Serve connects from the same
machine, and puts the caller's Tailscale address in `X-Forwarded-For`):

```json
{
  "mcpBaseUrl": "https://your-machine.your-tailnet.ts.net:4001",
  "trustedProxies": ["127.0.0.1", "::1"]
}
```

Then restart the server, and use
`https://your-machine.your-tailnet.ts.net:4001/mcp` as the URL when you [connect
a client](../connect).

`mcpBaseUrl` has to be the address clients actually use. The
`upload-binary-file` tool builds its URL from it, so a wrong name there gives an
upload URL that does not resolve, or is refused with a 403. See [Putting HTTPS
in front of the server](../install#putting-https-in-front-of-the-server) for the
symptoms.

### Docker

The container publishes its port on the machine, and `tailscale serve` runs on
the machine, not in the container, so the command above is unchanged. Set
`trustedProxies` in the config file the container reads, but the address to list
depends on your container runtime: a connection that arrives through a published
port may come from the container network's gateway (on the default Docker
bridge, usually `172.17.0.1`, inside `172.16.0.0/12`) and not from loopback.
Check the network with `docker network inspect bridge` and list the gateway or
its range. See [Run it in Docker](install-docker).

### Tailnet only: Serve and Funnel

`tailscale serve` is reachable only from devices on your tailnet.
[`tailscale funnel`](https://tailscale.com/docs/features/tailscale-funnel)
exposes the same thing to the whole internet. Do not use Funnel with the server
in its default, unauthenticated mode: anyone who found the address could read
and write your vault. See [Security](../security).

With [`auth`](../configuration#authentication-auth) set, every request to `/mcp`
needs a signed token for a listed user, so Funnel can be the public address that
a client, or a Worker such as the one on the [Cloudflare
page](install-cloudflare-oauth), reaches the server by. Funnel serves only ports
443, 8443 and 10000, so use one of them in the `tailscale funnel` command and in
`mcpBaseUrl`. The upload URLs and the discovery documents are public by design;
see [Security](../security#authentication).

To let a person or device that is not yours use the server, share the machine
with them from the admin console, or add their device to your tailnet, rather
than opening it to the internet. Sharing gives them the whole machine, not only
this port, so limit what they can reach with your tailnet's access controls
(ACLs).

### Renaming the machine

The URL contains the machine's name. If you rename the machine, or move it to
another tailnet, the old URL stops working. Change `mcpBaseUrl`, restart the
server, re-run `tailscale serve` if `tailscale serve status` no longer shows it,
and change the saved connection in every client.

Without `auth`, the server's OAuth flow is deliberately public, so this network
layer is what controls access. See [Security](../security).
