# cloudflare-pages-mcp

Remote MCP server (Streamable HTTP + OAuth 2.1) to create Cloudflare Pages
projects and deploy a directory of static files (for example, Claude-generated
HTML) to a live `*.pages.dev` site using the Cloudflare Direct Upload API.

It runs as an HTTP service so you can add it to Claude as a **custom
connector** over HTTPS, with built-in OAuth 2.1 (PKCE, dynamic client
registration) gated behind a single shared password.

## Tools

- `create_project` — create a new Pages project (`<name>.pages.dev`).
- `deploy` — upload a directory and publish a deployment.
- `list_projects` — list existing projects.
- `get_project` — fetch one project's details.
- `delete_project` — delete a project.

## Endpoints

- `POST /mcp` — Streamable HTTP MCP endpoint (use this URL in Claude).
- `GET /health` — health check, returns `{ "status": "ok", "auth": "<mode>" }`.

## Requirements

- Node.js >= 22.
- A Cloudflare API token with the **Cloudflare Pages: Edit** permission.
- Your Cloudflare **Account ID**.

## Configuration

All configuration is via environment variables.

| Variable                  | Required | Default           | Description                                                                   |
| ------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | yes      | —                 | API token with Pages edit permission.                                         |
| `CLOUDFLARE_ACCOUNT_ID`   | yes      | —                 | Account ID that owns the projects.                                            |
| `CLOUDFLARE_API_BASE_URL` | no       | public API        | Override the API base URL (testing).                                          |
| `PORT`                    | no       | `3000`            | HTTP port to listen on.                                                       |
| `HOST`                    | no       | `0.0.0.0`         | Interface to bind to.                                                         |
| `PUBLIC_BASE_URL`         | no       | —                 | Public URL the server is reachable at (also the default OAuth issuer).        |
| `MCP_AUTH_TOKEN`          | no       | —                 | If set, every `POST /mcp` must send `Authorization: Bearer <token>`.          |
| `OAUTH_PASSWORD`          | no       | —                 | Enables the OAuth 2.1 server; the password users enter on the consent screen. |
| `OAUTH_ISSUER_URL`        | no       | `PUBLIC_BASE_URL` | Public https issuer URL for OAuth.                                            |
| `OAUTH_SIGNING_SECRET`    | no       | random            | HMAC secret for signing tokens. `openssl rand -hex 32`.                       |
| `OAUTH_ACCESS_TOKEN_TTL`  | no       | `3600`            | Access-token lifetime (seconds).                                              |
| `OAUTH_REFRESH_TOKEN_TTL` | no       | `2592000`         | Refresh-token lifetime (seconds).                                             |
| `TRUST_PROXY`             | no       | `1`               | Express `trust proxy` (proxy hops, or `true`/`false`).                        |
| `MAX_BODY_SIZE`           | no       | `25mb`            | Max accepted JSON request body size.                                          |
| `RATE_LIMIT_WINDOW_MS`    | no       | `60000`           | Rate-limit window in ms.                                                      |
| `RATE_LIMIT_MAX`          | no       | `60`              | Max requests per window per IP (`0` disables).                                |
| `ALLOWED_ORIGINS`         | no       | —                 | Comma-separated Origin allow-list for `/mcp`.                                 |

Authentication modes are chosen automatically:

- **OAuth 2.1** when `OAUTH_PASSWORD` is set (required for Claude connectors).
- **Static token** when only `MCP_AUTH_TOKEN` is set.
- **Open** when neither is set (use only behind your own network boundary).

## Quickstart (Docker)

```bash
cp .env.example .env   # fill in CLOUDFLARE_* and (for Claude) OAUTH_*
docker compose up -d --build

curl -s http://localhost:3000/health
# {"status":"ok","auth":"oauth", ...}
```

Run it behind a reverse proxy that terminates TLS and set `PUBLIC_BASE_URL`
(and therefore `OAUTH_ISSUER_URL`) to your public `https://` URL.

## Quickstart (local)

```bash
npm install
npm run build
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm start
```

For development with auto-reload, use `npm run dev`.

## Connect to Claude

1. Deploy this server behind HTTPS and set `OAUTH_PASSWORD`, `PUBLIC_BASE_URL`
   (= your public `https://` URL) and a stable `OAUTH_SIGNING_SECRET`.
2. In Claude, go to **Settings → Connectors → Add custom connector**.
3. Enter the MCP URL: `https://<your-host>/mcp`.
4. Claude performs OAuth discovery and dynamic client registration, then opens
   the consent screen. Enter your `OAUTH_PASSWORD` to authorize.
5. The five Cloudflare Pages tools become available in your conversations.

You can confirm the server is healthy before connecting:

```bash
curl -s https://<your-host>/health
```

## Security

- Treat your Cloudflare API token as a secret; never commit it. Scope it to the
  minimum (Pages edit only).
- Always enable OAuth (or at least `MCP_AUTH_TOKEN`) when the server is exposed
  publicly — it holds your Cloudflare credentials.
- Set a stable `OAUTH_SIGNING_SECRET` in production so issued tokens survive
  restarts and are shared across instances.

## License

MIT
