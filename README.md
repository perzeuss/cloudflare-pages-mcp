# cloudflare-pages-mcp

Remote MCP server (Streamable HTTP + OAuth 2.1) to create Cloudflare Pages
projects and deploy static files (for example, Claude-generated HTML/CSS/JS)
to a live `*.pages.dev` site using the Cloudflare Direct Upload API.

It runs as an HTTP service so you can add it to Claude as a **custom
connector** over HTTPS, with built-in OAuth 2.1 (PKCE, dynamic client
registration) gated behind a single shared password.

## Tools

- `create_project` — create a new Pages project (`<name>.pages.dev`).
- `deploy` — upload a set of inline files and publish a deployment (single call).
- `create_deployment` / `add_files` / `publish_deployment` — staged, chunked
  deploy for large sites: open a deployment, append files across several small
  calls, then publish them as one deployment (works around the per-call output
  size limit).
- `create_upload_url` — get a short-lived signed URL to upload a large **binary**
  asset (image, video, font) into a staged deployment with an HTTP `PUT`, so its
  bytes never pass through the model. An agent with a shell uploads the local
  file directly, e.g. `curl -T ./hero.jpg "<upload_url>"`. Requires
  `PUBLIC_BASE_URL` to be set.

### Large sites and binary assets

A remote connector receives every tool argument as model output, so text files
go inline (`deploy` for small sites, `create_deployment` → `add_files` →
`publish_deployment` for large ones). **Binary** assets are different: base64
inline is wasteful and quickly exceeds the per-call limit. Instead:

1. `create_deployment` → `deploy_id`
2. (optionally) `add_files` for the HTML/CSS/JS
3. `create_upload_url` with the `deploy_id` and target `path` → returns a signed
   URL + a ready `curl -T` command; upload each image/video straight from disk
4. `publish_deployment` → publishes everything as one deployment

The upload bytes stream directly to the server and never go through the model.
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

# Verify from inside the container (no host port is published by default):
docker compose exec cloudflare-pages-mcp \
  node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok","auth":"oauth", ...}
```

By default the service only `expose`s port 3000 on the Docker network — it does
**not** publish a host port, so it never collides with something already bound
on the host. Run it behind a reverse proxy (Caddy, nginx, Traefik, …) on the
same network that terminates TLS and forwards to `cloudflare-pages-mcp:3000`,
and set `PUBLIC_BASE_URL` (and therefore `OAUTH_ISSUER_URL`) to your public
`https://` URL.

To reach it directly from the host instead (local testing without a proxy),
uncomment the `ports:` block in `docker-compose.yml` and pick a free port:

```bash
HOST_PORT=8787 docker compose up -d
curl -s http://localhost:8787/health
```

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
