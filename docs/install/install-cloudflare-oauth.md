---
layout: docs
title: "Sign in with Cloudflare's workers-oauth-provider | obsidian-mcp-brain"
---

## Sign in with Cloudflare's workers-oauth-provider

[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
is a library for writing an OAuth service as a Cloudflare Worker. It is not a service you
configure: you write a small Worker that uses it, and deploy that Worker yourself. This
page gives that Worker in full, as a starting point, and shows how it connects to the
server so that the Claude mobile app and claude.ai can sign in. The server stays
reachable over HTTPS at an address of its own and runs with
[`auth`](../configuration#authentication-auth) set; the Worker is what clients talk to.

To get a sign-in with settings only and no Worker, see
[Cloudflare Tunnel and Access](install-cloudflare-access).

### How the two fit together

The library issues opaque access tokens, and only its own Worker can check one: the
token record and its encrypted properties are in the Worker's KV namespace. This server
checks signed tokens against a published key set and cannot call the Worker to check an
opaque one. So the Worker does both jobs for the client, and passes each request on with
a signed token of its own:

```text
Claude app ──▶ Worker (workers-oauth-provider)  ──▶  obsidian-mcp-brain
   opaque access token     │ checks it, then signs a    checks the signature against
                           │ 60-second ES256 token      the Worker's key document
                           ▼
                  /.well-known/jwks.json
```

- The client signs in to the Worker, and sees the Worker's address as the MCP server.
- The Worker checks the client's token and the user, then forwards the request to the
  server with `Authorization: Bearer <signed token>`. The token's `sub` is the user's id.
- The server fetches the Worker's public key from `/.well-known/jwks.json`, checks the
  signature, `iss`, `aud` and expiry, and looks `sub` up in `users` or `readOnlyUsers`.

The user is checked twice: the Worker signs in only the ids in `ALLOWED_USERS`, and
the server refuses a `sub` that is not in its own lists with `403`.

### What you need

- A Cloudflare account, and Node.js to build and deploy a Worker project with `wrangler`.
- The server reachable over HTTPS by the Worker at its own hostname, for example
  `https://mcp-origin.example.com`, through any of the ways on the
  [install page](../install#putting-https-in-front-of-the-server). This is a different
  name from the Worker's. Every request to `/mcp` on it needs a valid token.
- Somewhere for people to sign in. The example uses a GitHub OAuth app; the library's
  [upstream sign-in guide](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md)
  covers other providers, and replacing `authorize` and `callback` below is all it takes.

### 1. Make a signing key

The Worker signs with an EC P-256 key. Generate it and store it as a Worker secret; the
Worker's `/.well-known/jwks.json` publishes only the public half.

Run the command from the Worker project directory that [step 3](#3-create-the-worker-project)
creates, since `wrangler` takes the Worker's name from the `wrangler.jsonc` there.

```sh
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'});k.kid=c.randomUUID();console.log(JSON.stringify(k))" \
  | npx wrangler secret put JWT_PRIVATE_JWK
```

### 2. Configure the server

```json
{
  "mcpBaseUrl": "https://mcp-origin.example.com",
  "auth": {
    "issuer": "https://mcp.example.com",
    "jwksUri": "https://mcp.example.com/.well-known/jwks.json",
    "users": ["12345678"]
  }
}
```

- `mcpBaseUrl` is the server's own address, not the Worker's. The `audience` it implies
  (`https://mcp-origin.example.com/mcp`) is what the Worker puts in `aud`. The server
  also builds its upload URLs from it, so it has to be an address an agent can reach.
- `issuer` is the Worker's address, exactly as the Worker's `PUBLIC_URL` variable has it,
  and `jwksUri` is where the Worker serves its key document.
- `users` lists the user ids the Worker signs: with the example sign-in this is the
  GitHub numeric id (`curl https://api.github.com/users/<login>` shows it as `id`).
  Add `readOnlyUsers` for people who may only read.

### 3. Create the Worker project

This is a Worker project of your own, kept outside this repository. Make an empty
directory with these files:

```text
mcp-front/
├── package.json        npm install @cloudflare/workers-oauth-provider, and wrangler
├── wrangler.jsonc      below
└── src/index.ts        below
```

```sh
mkdir mcp-front && cd mcp-front && npm init -y
npm install @cloudflare/workers-oauth-provider
npm install --save-dev wrangler
npx wrangler kv namespace create OAUTH_KV      # prints the id for wrangler.jsonc
```

`src/index.ts` is the whole Worker. It does four things: it hands the library its
settings, serves the key document, runs the sign-in (`authorize` and `callback`), and
forwards each `/mcp` request to the server (`mcp`). Edit it for your own sign-in and
hostnames.

`src/index.ts`:

```ts
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
  authorizationErrorRedirect,
} from '@cloudflare/workers-oauth-provider';

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL: string; // https://mcp.example.com, this Worker's own address
  ORIGIN_URL: string; // https://mcp-origin.example.com, where the MCP server answers
  ALLOWED_USERS: string; // comma-separated GitHub numeric ids
  JWT_PRIVATE_JWK: string; // Worker secret: the signing key, as a JSON JWK
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string; // Worker secret
}

type Props = { userId: string };

/* ---- Signed token for the MCP server ------------------------------------------------ */

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encode = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function signToken(privateJwk: JsonWebKey & { kid: string }, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const input = `${encode({ alg: 'ES256', typ: 'at+jwt', kid: privateJwk.kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(signature)}`;
}

/** The public half of the signing key, as the document the MCP server fetches. */
function jwks(env: Env): Response {
  const { kty, crv, x, y, kid } = JSON.parse(env.JWT_PRIVATE_JWK);
  return Response.json(
    { keys: [{ kty, crv, x, y, kid, use: 'sig', alg: 'ES256' }] },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}

/* ---- /mcp: check the client's token (the library did), then pass the request on ------ */

const allowed = (env: Env, userId: string): boolean =>
  env.ALLOWED_USERS.split(',').map((id) => id.trim()).includes(userId);

const mcp = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { userId } = ctx.props as Props;
    if (!allowed(env, userId)) return new Response('Forbidden', { status: 403 });
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(JSON.parse(env.JWT_PRIVATE_JWK), {
      iss: env.PUBLIC_URL,
      aud: `${env.ORIGIN_URL}/mcp`,
      sub: userId,
      iat: now,
      exp: now + 60,
    });
    const url = new URL(request.url);
    const upstream = new Request(new URL(url.pathname + url.search, env.ORIGIN_URL), request);
    upstream.headers.set('Authorization', `Bearer ${token}`);
    return fetch(upstream);
  },
};

/* ---- Everything else: sign-in and the key document ------------------------------------ */

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/.well-known/jwks.json') return jwks(env);
      if (url.pathname === '/authorize') return await authorize(request, env);
      if (url.pathname === '/callback') return await callback(request, env);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return new Response('This sign-in request is not valid. Start again from the client.', { status: 400 });
      }
      throw error;
    }
    return new Response('Not found', { status: 404 });
  },
};

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === 'GET') {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    const origin = details.clientDomain
      ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
      : 'This app registered itself; its name is not verified.';
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Authorize</title>
<h1>Allow ${escapeHtml(details.clientName)} to use your vault?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`,
      { headers: consent.headers },
    );
  }

  const form = await request.formData();
  const handle = String(form.get('handle'));
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const github = new URL('https://github.com/login/oauth/authorize');
  github.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  headers.set('Location', github.toString());
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const params = new URL(request.url).searchParams;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);

  const denied = (): Response => {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  };
  if (params.get('error') || !params.get('code')) return denied();

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: params.get('code'),
      redirect_uri: `${env.PUBLIC_URL}/callback`,
      code_verifier: data.verifier,
    }),
  });
  const { access_token } = (await tokenResponse.json()) as { access_token?: string };
  if (!access_token) return denied();

  const userResponse = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'mcp-front' },
  });
  const user = (await userResponse.json()) as { id?: number };
  const userId = String(user.id ?? '');
  if (!userId || !allowed(env, userId)) return denied();

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId,
    metadata: {},
    scope: original.scope,
    props: { userId } satisfies Props,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

export default new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: mcp,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600,
  scopesSupported: ['mcp'],
  requiredScopes: ['mcp'],
  resourceMetadata: {
    resource: 'https://mcp.example.com/mcp',
    authorization_servers: ['https://mcp.example.com'],
  },
});
```

Replace `https://mcp.example.com` in `resourceMetadata` with the Worker's address, the
same value as `PUBLIC_URL`. A client names the MCP server by this address when it asks
for a token, so it has to be the address the client was given.

`wrangler.jsonc`:

```jsonc
{
  "name": "mcp-front",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "routes": [{ "pattern": "mcp.example.com", "custom_domain": true }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<id from: wrangler kv namespace create OAUTH_KV>" }],
  "vars": {
    "PUBLIC_URL": "https://mcp.example.com",
    "ORIGIN_URL": "https://mcp-origin.example.com",
    "ALLOWED_USERS": "12345678",
    "GITHUB_CLIENT_ID": "<client id>"
  }
}
```

`global_fetch_strictly_public` is required for the Client ID Metadata Documents the
library accepts from clients. `ALLOWED_USERS` takes the same ids as the server's
`users` and `readOnlyUsers`; an id left out of it is refused by the Worker as well.

### 4. Register the sign-in app and deploy

1. In GitHub, create an OAuth app with the callback URL `https://mcp.example.com/callback`.
2. Put its client id in `GITHUB_CLIENT_ID` above, and its secret in the Worker:
   `npx wrangler secret put GITHUB_CLIENT_SECRET`.
3. From the project directory, run `npx wrangler deploy`.
4. Restart the server so that it reads the `auth` settings.

### 5. Add the connector

In claude.ai, or the mobile app, add a custom connector with the Worker's address and
`/mcp` on the end: `https://mcp.example.com/mcp`. Claude opens the Worker's consent page,
which sends the user to GitHub; on return the Worker issues the client its tokens.

For Claude Code: `claude mcp add --transport http obsidian https://mcp.example.com/mcp`,
then `/mcp` to sign in.

### Notes

- **Token lifetime.** `accessTokenTTL` is how long a client's token lasts before it
  refreshes. The token the server sees lives for 60 seconds and is made per request, so
  the server's only long-lived trust is in the Worker's key.
- **Removing a user.** Take the id out of `ALLOWED_USERS` and redeploy: the Worker refuses
  that user's next request, whatever token the client holds. Take it out of the server's
  lists too, and restart.
- **Rotating the key.** The key document lists the keys the server should accept. Put the
  new key's public half in `jwks()` next to the old one, switch the secret, and remove the old
  entry once its 60-second tokens have expired.
- **`PUT /up/<token>` uploads** go straight to the server at its own address, with the
  one-time URL from `upload-binary-file`, and do not pass through the Worker.
- **Logging.** The server's log names the user and the reason for each refusal; the
  Worker never logs a token.
