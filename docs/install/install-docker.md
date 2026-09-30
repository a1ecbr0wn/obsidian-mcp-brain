---
layout: docs
title: "Run it in Docker | obsidian-mcp-brain"
---

## Run it in Docker

A container image is published to the GitHub Container Registry as
`ghcr.io/a1ecbr0wn/obsidian-mcp-brain`, for `linux/amd64` and `linux/arm64`. It is an
alternative to [installing from npm](install-npm): you don't need Node.js on the
host, and the server is configured the same way, through one JSON
[config file](../configuration).

The image does not include `graphify`, so the `query-graph` tool always returns an
error inside a container: "graphify command not found on PATH" for a vault that
already has a graph (or "graphify-out/graph.json not found" for one that doesn't).
Every other tool works. If
you need `query-graph`, use a [native install](install-npm), where a locally
installed `graphify` is found on the server's `PATH`.

### Configure it

Two settings differ from a native run:

- `listenHost` must be `"0.0.0.0"`. The default, `127.0.0.1`, is the container's
  own loopback, which the port you publish can never reach.
- Vault paths are paths *inside* the container, so you mount each vault there. The
  examples below mount one at `/vaults/knowledge`.

```json
{
  "listenHost": "0.0.0.0",
  "mcpBaseUrl": "https://your-hostname:4001",
  "vaults": {
    "knowledge": { "path": "/vaults/knowledge" }
  }
}
```

`mcpBaseUrl` is still the public HTTPS address of whatever sits in front of the
container, not the container's own address. The container serves plain HTTP and
does not terminate TLS.

### With `docker run`

```sh
docker run -d --name obsidian-mcp-brain --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -v /path/to/your/obsidian/vault:/vaults/knowledge \
  -v /path/to/obsidian-mcp.json:/config/obsidian-mcp.json:ro \
  -p 127.0.0.1:3002:3002 \
  ghcr.io/a1ecbr0wn/obsidian-mcp-brain
```

- The config is read from `/config/obsidian-mcp.json`, which is the image's
  default `CONFIG_PATH`. Mount it read-only, and make sure the user the container
  runs as can read it, or the server exits at startup.
- `-p 127.0.0.1:3002:3002` publishes the port on the host's loopback only, so other
  machines cannot reach the container directly. Other containers on the same Docker
  network still can, and the server has no authentication of its own, so keep
  untrusted containers off that network. Drop the `127.0.0.1:` only if you
  deliberately want other machines to reach it directly; see [Security](../security).
- If you change `listenPort` in the config, publish that port instead of `3002`.

### With `docker compose`

```yaml
services:
  obsidian-mcp-brain:
    image: ghcr.io/a1ecbr0wn/obsidian-mcp-brain:1
    restart: unless-stopped
    user: "${UID:-1000}:${GID:-1000}"
    ports:
      - "127.0.0.1:3002:3002"
    volumes:
      - /path/to/your/obsidian/vault:/vaults/knowledge
      - ./obsidian-mcp.json:/config/obsidian-mcp.json:ro
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
```

Start it with `docker compose up -d`.

`user:` runs the container as your own user when `UID` and `GID` are set, and as
the image's default user (UID 1000) otherwise. Bash does not export `UID`, so put
both in a `.env` file next to the compose file:

```sh
printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)" > .env
```

### File ownership

The image runs as an unprivileged user with UID 1000, and the server writes notes
into your vault as whichever user the container runs as. On a Linux host, files
created by a UID that isn't yours can be awkward to edit from Obsidian or your sync
tool, and the container can't write at all if that user can't write to the vault.
Run the container as your own user with `--user` (or `user:` in compose), as in the
examples. On Docker Desktop for macOS, bind-mounted files are presented as your own
user whichever UID the container uses, so this matters mainly on Linux.

### Hardening

The server writes only inside the vaults, so the container runs with a read-only
root filesystem, no Linux capabilities and no privilege escalation, as the compose
example shows. These flags shrink what a compromised server process could do to the
container and the host; they do not limit what a connected client can do to your
notes, because the vault is a writable mount. Only mounting the vault with `:ro`
does that, and the write tools then fail. The [path deny list](../configuration)
works the same as in a native install.

### Put HTTPS in front

Remote MCP clients need an HTTPS URL. Point your HTTPS layer at the published port
just as you would for a native install; if you use
[Tailscale Serve](install-tailscale) on the host, the command is unchanged:

```sh
sudo tailscale serve --bg --https 4001 http://localhost:3002
```

A reverse proxy running as another container on the same user-defined Docker
network can also reach the server at `obsidian-mcp-brain:3002` without any
published port. A compose project's default network is one; the default bridge
used by a plain `docker run` is not, and does not resolve container names.

### Updating and versions

Images are tagged `X.Y.Z`, `X.Y`, `X` and `latest`, published with each release
alongside the npm package of the same version. A full `X.Y.Z` tag never changes,
while `X.Y` and `X` follow the newest matching release, so the `:1` in the compose
example picks up every 1.x release. To update:

```sh
docker compose pull && docker compose up -d
```

or, with `docker run`, pull the image and recreate the container.

The image has a health check, so `docker ps` shows `healthy` once the server is
answering; it follows the `listenHost` and `listenPort` in the mounted config.
