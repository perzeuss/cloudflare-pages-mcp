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
- `read_page` — read text from an existing project's production URL, optionally
  using server-side Access service-token credentials.
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

## Reusable Cloudflare Access policies

Configure login providers and reusable **Allow** policies in Cloudflare Zero Trust.
The server only stores names and policy IDs; it does not create login rules or
handle visitor passwords or identity-provider secrets.

Copy [access-policies.example.yaml](access-policies.example.yaml) to
`access-policies.yaml`, or [access-policies.example.json](access-policies.example.json)
to `access-policies.json`. Replace the example UUID with an existing reusable
Allow policy ID from your Cloudflare account. The names are freely chosen lookup
names. Keep `DEFAULT_ACCESS_POLICY_ID` in the environment; a catalog key named
`default` does not set it.

Both formats contain the same name-to-ID mapping:

```yaml
private_pages: f174e90a-fafe-4643-bbbc-4a0ed4fc8415
project_team: 597147a1-976b-4ef2-9af0-81d5d007fc34
```

```json
{
  "private_pages": "f174e90a-fafe-4643-bbbc-4a0ed4fc8415",
  "project_team": "597147a1-976b-4ef2-9af0-81d5d007fc34"
}
```

Configure the server with environment variables:

```dotenv
ACCESS_POLICIES_FILE=/config/access-policies.yaml
# Alternatively, or to override individual names from the file:
ACCESS_POLICIES={"private_pages":"f174e90a-fafe-4643-bbbc-4a0ed4fc8415"}
DEFAULT_ACCESS_POLICY_ID=f174e90a-fafe-4643-bbbc-4a0ed4fc8415
```

`ACCESS_POLICIES` must be JSON. File catalogs support JSON and YAML. Names must
start with a lowercase letter and contain only lowercase letters, digits and
underscores (maximum 64 characters). IDs must be UUIDs. Duplicate YAML keys,
aliases, unreadable files and invalid configuration stop startup. The file limit
is 1 MiB. Restart the server after changing its configuration. With Docker,
mount the file read-only and use its **container path** in `ACCESS_POLICIES_FILE`.

Agents can discover the catalog with `list_access_policies` and look up a name
with `get_access_policy {"name":"private_pages"}`. An omitted name returns the
default ID. Select a policy on any project/deployment entry point:

```json
{
  "project_name": "my-site",
  "access_policy": "private_pages",
  "files": [{ "path": "index.html", "content": "<h1>Private site</h1>" }]
}
```

For staged uploads, pass `access_policy` to `create_deployment`; the resolved ID
is retained until `publish_deployment`, where Cloudflare protection is checked.
`create_project` also accepts `access_policy`. Explicit names take precedence
over `DEFAULT_ACCESS_POLICY_ID`. Unknown names fail, even if a default exists.
Tool callers cannot pass an arbitrary policy ID or disable the server default.
If neither a selection nor a default exists, deployments retain their previous
behavior; the server does not remove existing Access protection.

The Cloudflare token needs **Cloudflare Pages: Edit** and, when using Access,
**Access: Apps and Policies Write** on the same account. The server verifies that
the selected policy is reusable and has action `Allow`, then creates or verifies
full-host self-hosted Access applications for the actual project subdomain,
`*.<project-subdomain>` (deployment and preview URLs), and all custom domains
reported by Pages. Each application references the existing policy by ID.

Before any assets are uploaded to Cloudflare, the server reads back the Access
applications. The selected Allow policy must remain present. Additional existing
policies are accepted only when they are reusable **Service Auth** policies;
the server reads and validates their IDs and actions without changing them.
Additional Allow policies and Bypass policies remain unsupported. Conflicting
policies, path-specific applications, overlapping
hostnames, public path overrides, preflight bypasses and API errors abort the
upload. Existing applications with incompatible configuration are **not**
overwritten; resolve the conflict in Cloudflare and retry. A partially failed
operation can leave an empty Pages project or some Access applications in place;
these are deliberately retained rather than deleting an operator's protection.
Failed staged publications retain the staged files until retry or expiry.

These checks verify the control-plane configuration, not edge propagation or a
successful interactive login. Validate a private-browser login and anonymous
requests to the production, deployment and custom-domain URLs before uploading
sensitive content. Changes made directly in Cloudflare can affect protection
between checks. Newly added custom domains are included on the next protected
deployment and should be protected before routing traffic to them. There is no
custom authentication Worker, and existing deployment URLs remain subject to
the hostname-based Access rules.

References: [reusable policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/),
[Access application API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/),
[Pages production and preview protection](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain).

### Policy files with Dokploy Compose

Create a File Mount in Dokploy with File Path `policies.yaml` and your YAML
catalog as Content. In the existing service definition, add:

```yaml
environment:
  ACCESS_POLICIES_FILE: /config/policies.yaml
volumes:
  - ../files/policies.yaml:/config/policies.yaml:ro
```

Merge these entries into the existing `environment` and `volumes` sections.
With Compose, the mount target is set in the Compose file; the File Mount UI
may not expose an editable Mount Path. Redeploy after saving both changes.
The ENV path must match the container target, including the filename.
`DEFAULT_ACCESS_POLICY_ID` remains a separate ENV setting; a catalog entry
named `default` is an ordinary lookup name.

### Reading protected pages

`read_page` performs a GET of a project's canonical production `pages.dev` URL:

```json
{ "project_name": "my-site", "path": "/test/" }
```

The project must exist in the configured Cloudflare account. Arbitrary URLs,
custom domains, deployment URLs, custom request headers and non-GET methods are
not accepted. Redirects are not followed, so `/test/` may work where `/test`
redirects. Results contain text only (maximum 1 MiB, 20-second timeout), not a
rendered page or the full original source project. Returned page content is
untrusted data. A separate browser tool is not automatically authenticated.

For protected pages, keep the existing user-login policy and configure an
additional **Service Auth** policy in Cloudflare that allows a specific service
token. Existing Service Auth policies can be reused. The MCP does not create,
attach, edit or remove machine-access policies. Set both credentials on the
server, using environment variables or your host's secret injection:

```dotenv
ACCESS_SERVICE_TOKEN_CLIENT_ID=<service-token-client-id>
ACCESS_SERVICE_TOKEN_CLIENT_SECRET=<service-token-client-secret>
```

These are Access **service-token** credentials, not Google OAuth credentials or
the Cloudflare management API token. They are never tool arguments or returned
as credentials. The read request sends `CF-Access-Client-Id` and
`CF-Access-Client-Secret` only to the project's canonical production hostname.
Without credentials, public pages can still be read; protected requests fail
normally. Incomplete credential pairs stop startup. Machine credentials also require an
authenticated MCP endpoint (`MCP_AUTH_TOKEN` or the existing OAuth login configured
with `OAUTH_PASSWORD`); an open endpoint is rejected. Existing policy file and
`DEFAULT_ACCESS_POLICY_ID` settings remain unchanged.

All authenticated callers of this MCP share the configured machine credential's
read access. Use a dedicated token restricted to the intended applications and
set its expiration in Cloudflare. Access service tokens are not inherently
read-only; `read_page` limits its requests to GET, while the Cloudflare policy
and target application define the token's actual permissions. No OAuth consent
website or user-session delegation is involved.

For a reusable Service Auth policy, Cloudflare's API accepts the following JSON
via `POST /accounts/{account_id}/access/policies`:

```json
{
  "name": "Pages MCP reader",
  "decision": "non_identity",
  "include": [{ "service_token": { "token_id": "<service-token-uuid>" } }]
}
```

The `token_id` is the service token's resource UUID, not its client ID or secret.
Attach the resulting policy to the relevant Access applications in Cloudflare,
including production, previews and custom domains as needed. Do not use Bypass.
See [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
and [Service Auth policy setup](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/#authenticate-a-service-using-a-service-token).

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
