---
layout: docs
title: "Protect it with Cloudflare Tunnel and Access | obsidian-mcp-brain"
---

## Protect it with Cloudflare Tunnel and Access

Cloudflare Tunnel gives the server a public HTTPS address without opening a port, and
Cloudflare Access (Zero Trust) puts a login in front of it. With
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
on, Access is also the OAuth service the Claude mobile app and claude.ai sign in to, so
nothing has to be written or deployed besides the tunnel. The server runs with
[`auth`](../configuration#authentication-auth) set and checks the signed assertion that
Access forwards with every request.

This is the no-code alternative to
[a Worker built with workers-oauth-provider](install-cloudflare-oauth), which gives you
full control of the sign-in and consent screens.

### How the two fit together

```text
Claude app ──▶ Cloudflare Access ──▶ Tunnel ──▶ cloudflared ──▶ obsidian-mcp-brain
   opaque       checks the token,     (public    on the same     checks the signature of
   access       applies your          hostname)  machine         Cf-Access-Jwt-Assertion
   token        policy, adds the
                signed assertion
```

- The client signs in to Access and holds an opaque access token (`oauth:…`) that only
  Access can read.
- Access resolves that token to the user, applies your policy, and passes the request on
  with a signed JWT in the `Cf-Access-Jwt-Assertion` header.
- The server reads that header (`tokenHeader`), checks the signature against Access's
  published keys, then `iss`, `aud` and expiry, and looks the user's email up in `users`
  or `readOnlyUsers`.

### What you need

- A domain in your Cloudflare account, and a Cloudflare Zero Trust organization.
- The server running on the machine that will run `cloudflared`, listening on its
  default `127.0.0.1:3002`.
- An identity provider configured in Zero Trust (one-time PIN by email is the simplest).

### 1. Create the tunnel

In the Cloudflare dashboard, go to **Networking > Tunnels** and select **Create a
tunnel**. Name it, choose **Linux**, and run the command the dashboard shows on the
machine that runs the server. Then, on the tunnel's **Routes** tab, select **Add route >
Published application**:

| Field | Value |
|---|---|
| Subdomain and Domain | `mcp` on `example.com`, which makes `mcp.example.com` |
| Service URL | `http://localhost:3002` |

The tunnel connects out from the machine, so nothing listens on a public port. Keep
`listenHost` at its default so the server cannot be reached except through `cloudflared`.

### 2. Put Access in front of the hostname

1. In **Zero Trust > Access controls > AI controls > MCP servers**, select **Add an MCP
   server**.
2. Enter a name and the URL with its path: `https://mcp.example.com/mcp`.
3. Add a policy that allows only the people who may use the vault, for example an
   **Emails** rule listing your address.
4. Choose the identity providers, then **Save**.
5. Edit the application, open **Advanced settings** and turn on **Managed OAuth**.

Managed OAuth settings you may want to change on that tab:

| Setting | What it does |
|---|---|
| Access token lifetime | How long a token authenticates requests before the client refreshes it. Policies are checked again at each refresh |
| Grant session duration | How long the refresh token lasts. When it ends the user logs in again |
| Allowed redirect URIs | Where dynamically registered clients may be sent after login. Add the redirect address of any client that is refused |

Managed OAuth needs an OAuth client that sends the `resource` parameter
([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)), which MCP clients do.

### 3. Configure the server

From the application's settings in the dashboard, copy its **Application Audience (AUD)
Tag**. Your team name is the first part of your `…cloudflareaccess.com` address.

```json
{
  "mcpBaseUrl": "https://mcp.example.com",
  "auth": {
    "issuer": "https://<team-name>.cloudflareaccess.com",
    "jwksUri": "https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs",
    "audience": "<AUD tag>",
    "userClaim": "email",
    "users": ["you@example.com"],
    "tokenHeader": "Cf-Access-Jwt-Assertion"
  }
}
```

- `audience` is the AUD tag, not the MCP URL.
- `userClaim` is `email`: the assertion's `sub` is an opaque id. `users` and
  `readOnlyUsers` then take email addresses, compared without regard to case.
- `tokenHeader` makes the server read the assertion. When that header is present it is
  used before any `Authorization` header.
- `mcpBaseUrl` is the tunnel's public address, which is also where upload URLs point.

Restart the server so that it reads the `auth` settings.

### 4. Add the connector

In claude.ai or the Claude mobile app, add a custom connector with
`https://mcp.example.com/mcp`. Claude sends the user to the Access login, and on return
holds a token it refreshes by itself.

For Claude Code: `claude mcp add --transport http obsidian https://mcp.example.com/mcp`,
then `/mcp` to sign in. For Claude Desktop, use `mcp-remote` with the same address.

### Notes

- **Who can use it.** Access's policy decides who can sign in, and the server's `users`
  and `readOnlyUsers` decide who may use the vault. Both have to allow a person.
- **Key rotation.** Access rotates its signing key every 6 weeks and keeps the previous
  key valid for 7 days. The server refetches the key document when it sees an unknown
  key, so no change is needed.
- **Upload URLs.** `PUT /up/<token>` is a different path from `/mcp`, and an agent's
  `curl` carries no Access login. An Access application scoped to `/mcp` leaves `/up/`
  outside it, which is what an upload needs; if you scope the application to the whole
  hostname instead, add a Bypass policy for `/up/*`. The one-time token in the URL is the
  upload's credential.
- **Directly reachable servers.** The assertion is checked on every request, so the header
  cannot be forged. Keep `listenHost` on loopback anyway, so that the tunnel is the only
  way in.
- **Removing a user.** Remove them from the Access policy, which stops the next refresh,
  and from `users`, then restart the server.
