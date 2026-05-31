# cloudflare-pages-mcp

[![CI](https://github.com/perzeuss/cloudflare-pages-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/perzeuss/cloudflare-pages-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a.svg)

Remote MCP server (Streamable HTTP + OAuth 2.1) to create Cloudflare Pages
projects and deploy static files (for example, Claude-generated HTML/CSS/JS)
to a live `*.pages.dev` site using the Cloudflare Direct Upload API.

It runs as an HTTP service so you can add it to Claude as a **custom
connector** over HTTPS, with built-in OAuth 2.1 (PKCE, dynamic client
registration) gated behind a single shared password.

- [Tools](#tools)
- [Deploying a site from disk](#deploying-a-site-from-disk-recommended)
- [Browser & sandbox uploads (CORS)](#browser-and-sandbox-uploads-cors)
- [Endpoints](#endpoints) · [Configuration](#configuration)
- [Quickstart (Docker)](#quickstart-docker) · [Quickstart (local)](#quickstart-local)
- [Connect to Claude](#connect-to-claude) · [Security](#security)

## Tools

- `create_project` — create a new Pages project (`<name>.pages.dev`).
- `deploy` — upload a set of inline files and publish in a single call. Best for
  a small, fully model-generated site that is **not** on disk.
- `create_deployment` / `create_upload_url` / `publish_deployment` — staged
  deploy for a site that lives on disk, includes binary assets, or is too large
  for one `deploy` call. Open a deployment, get signed upload URLs for every file
  (a batch of `paths` in one call), upload them straight from disk, then publish
  everything as one deployment (see below). Requires `PUBLIC_BASE_URL`.
- `add_files` — **deprecated**, no longer stages files. Passing file content
  inline through the model is no longer supported for staged deployments; use
  `create_upload_url` to upload from disk instead.
- `list_projects` — list existing projects.
- `get_project` — fetch one project's details.
- `delete_project` — delete a project.

### Deploying a site from disk (recommended)

A remote connector receives every tool argument as model output, so pushing file
content through tool calls wastes tokens and hits the per-call size limit —
worst of all for binary assets. Instead, upload **every** file (HTML/CSS/JS and
binary) directly from disk via short-lived signed URLs, so the bytes never pass
through the model:

1. `create_deployment` → returns a `deploy_id`.
2. `create_upload_url` with the `deploy_id` and a batch of `paths` (every
   site-relative path) → returns one signed `PUT` URL per file, plus a
   ready-to-use TSV manifest.
3. Upload each local file with an HTTP `PUT`. No Cloudflare credentials or env
   vars are needed — the signed token in the URL **is** the authorization:

   ```bash
   curl -T ./dist/index.html "<upload-url>"
   ```

   The [`cloudflare-pages-upload` skill](skills/cloudflare-pages-upload) ships an
   `upload.sh` helper that uploads a whole manifest at once.

4. `publish_deployment` → publishes everything as one deployment and returns the
   live URL.

### Use it from an agent (copy-paste prompt)

The skill is **optional ergonomics**, not a requirement: the tool descriptions
already steer the model through the workflow, and `create_upload_url` returns
ready-to-run `curl -T` commands plus a manifest — so an agent with a shell can
upload from those directly, without installing anything. Use the prompt below
when you want the `upload.sh` manifest helper and a nudge to prefer the
from-disk path over inline uploads. (An agent that can call the tools but can't
make its own HTTP requests can't upload at all — it's limited to the inline
`deploy` tool.)

Paste this to an agent that has a shell and the `cloudflare-pages-mcp` connector
connected. It installs the upload skill, then deploys your site from disk —
without ever passing file contents through the model:

```text
Deploy the static site in ./dist to Cloudflare Pages using the
cloudflare-pages-mcp connector.

First install the upload skill into this project:

  mkdir -p .claude/skills/cloudflare-pages-upload
  curl -fsSL https://raw.githubusercontent.com/perzeuss/cloudflare-pages-mcp/main/skills/cloudflare-pages-upload/SKILL.md \
    -o .claude/skills/cloudflare-pages-upload/SKILL.md
  curl -fsSL https://raw.githubusercontent.com/perzeuss/cloudflare-pages-mcp/main/skills/cloudflare-pages-upload/upload.sh \
    -o .claude/skills/cloudflare-pages-upload/upload.sh
  chmod +x .claude/skills/cloudflare-pages-upload/upload.sh

Then follow the skill exactly:
  1. create_deployment to get a deploy_id.
  2. create_upload_url with that deploy_id and a `paths` array of EVERY file in
     ./dist (relative paths) to get one signed URL per file.
  3. Upload all files from disk with the skill:
       .claude/skills/cloudflare-pages-upload/upload.sh --manifest <file>
  4. publish_deployment to go live.

Do NOT pass file contents inline (no add_files), and do NOT set any CF_* /
PROJECT_NAME env vars — the upload needs nothing but the signed URL.
```

### Browser and sandbox uploads (CORS)

Uploads default to **server-to-server** (`curl` ignores CORS). To let a
**browser-based** uploader — e.g. a sandboxed agent whose origin is the opaque
`Origin: null` — `PUT` to the signed URL, enable CORS with
`UPLOAD_ALLOWED_ORIGINS`:

```bash
UPLOAD_ALLOWED_ORIGINS=*      # any origin, incl. opaque `null`
# or a comma-separated allow-list: https://app.example.com,https://other.example
```

This is safe to open: the signed token in the URL is the authorization and the
endpoint uses no cookies, so `*` exposes nothing the token wouldn't already.
When enabled, both `/upload/:token` and `/health` answer the `OPTIONS` preflight
(`204`) and return the CORS headers; the preflight runs **before** any auth.

Verify the deployed posture (no valid token needed — the preflight doesn't check
it):

```bash
curl -i -X OPTIONS "https://<your-host>/upload/x" \
  -H "Origin: null" -H "Access-Control-Request-Method: PUT"
# Expect: 204 + Access-Control-Allow-Origin: *
```

If `Access-Control-Allow-Origin` is missing, the running process doesn't see the
variable: confirm it is set **and forwarded into the container**
(`docker compose exec cloudflare-pages-mcp printenv UPLOAD_ALLOWED_ORIGINS`),
then restart. Behind a reverse proxy, ensure it forwards `OPTIONS` to the server
rather than answering or stripping it.

## Endpoints

- `POST /mcp` — Streamable HTTP MCP endpoint (use this URL in Claude).
- `GET /health` — health check, returns `{ "status": "ok", "auth": "<mode>" }`.
- `PUT /upload/:token` — direct file upload for staged deployments. The signed
  `:token` (handed out by `create_upload_url`) is the authorization, so this
  route is not behind the MCP auth. `OPTIONS` answers the CORS preflight when
  `UPLOAD_ALLOWED_ORIGINS` is set.

## Requirements

- Node.js >= 22.
- A Cloudflare API token with the **Cloudflare Pages: Edit** permission.
- Your Cloudflare **Account ID**.

## Configuration

All configuration is via environment variables.

| Variable                  | Required | Default                         | Description                                                                                                                                                                        |
| ------------------------- | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | yes      | —                               | API token with Pages edit permission.                                                                                                                                              |
| `CLOUDFLARE_ACCOUNT_ID`   | yes      | —                               | Account ID that owns the projects.                                                                                                                                                 |
| `CLOUDFLARE_API_BASE_URL` | no       | public API                      | Override the API base URL (testing).                                                                                                                                               |
| `PORT`                    | no       | `3000`                          | HTTP port to listen on.                                                                                                                                                            |
| `HOST`                    | no       | `0.0.0.0`                       | Interface to bind to.                                                                                                                                                              |
| `PUBLIC_BASE_URL`         | no       | —                               | Public URL the server is reachable at (also the default OAuth issuer).                                                                                                             |
| `MCP_AUTH_TOKEN`          | no       | —                               | If set, every `POST /mcp` must send `Authorization: Bearer <token>`.                                                                                                               |
| `OAUTH_PASSWORD`          | no       | —                               | Enables the OAuth 2.1 server; the password users enter on the consent screen.                                                                                                      |
| `OAUTH_ISSUER_URL`        | no       | `PUBLIC_BASE_URL`               | Public https issuer URL for OAuth.                                                                                                                                                 |
| `OAUTH_SIGNING_SECRET`    | no       | random                          | HMAC secret for signing tokens. `openssl rand -hex 32`.                                                                                                                            |
| `OAUTH_ACCESS_TOKEN_TTL`  | no       | `3600`                          | Access-token lifetime (seconds).                                                                                                                                                   |
| `OAUTH_REFRESH_TOKEN_TTL` | no       | `2592000`                       | Refresh-token lifetime (seconds).                                                                                                                                                  |
| `TRUST_PROXY`             | no       | `1`                             | Express `trust proxy` (proxy hops, or `true`/`false`).                                                                                                                             |
| `MAX_BODY_SIZE`           | no       | `25mb`                          | Max accepted JSON request body size.                                                                                                                                               |
| `RATE_LIMIT_WINDOW_MS`    | no       | `60000`                         | Rate-limit window in ms.                                                                                                                                                           |
| `RATE_LIMIT_MAX`          | no       | `60`                            | Max requests per window per IP (`0` disables).                                                                                                                                     |
| `ALLOWED_ORIGINS`         | no       | —                               | Comma-separated Origin allow-list for `/mcp`.                                                                                                                                      |
| `UPLOAD_SIGNING_SECRET`   | no       | `OAUTH_SIGNING_SECRET` / random | HMAC secret for signing direct-upload URLs. Set a stable value so upload URLs survive restarts / multiple instances.                                                               |
| `UPLOAD_ALLOWED_ORIGINS`  | no       | —                               | CORS for the `/upload` and `/health` endpoints. Empty = off (curl only); `*` = any origin incl. opaque `Origin: null` (browser/sandbox uploads); or a comma-separated origin list. |

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
5. The Cloudflare Pages tools become available in your conversations.

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
  restarts and are shared across instances. Likewise set `UPLOAD_SIGNING_SECRET`
  so in-flight upload URLs survive restarts and work across instances.
- Direct uploads are authorized solely by the short-lived signed token in the
  URL (no cookies). Only enable `UPLOAD_ALLOWED_ORIGINS` (especially `*`) if you
  want browser-based uploads; leave it unset for server-to-server-only setups.

## License

MIT
