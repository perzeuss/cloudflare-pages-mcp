## [1.2.1](https://github.com/perzeuss/cloudflare-pages-mcp/compare/v1.2.0...v1.2.1) (2026-05-31)


### Bug Fixes

* **compose:** forward all supported env vars ([#12](https://github.com/perzeuss/cloudflare-pages-mcp/issues/12)) ([58216c5](https://github.com/perzeuss/cloudflare-pages-mcp/commit/58216c5c7153552cb419131fae3bc397c4ea0c15))

# [1.2.0](https://github.com/perzeuss/cloudflare-pages-mcp/compare/v1.1.0...v1.2.0) (2026-05-31)


### Features

* extend opt-in CORS to /health and broaden allowed headers ([#11](https://github.com/perzeuss/cloudflare-pages-mcp/issues/11)) ([cbc8bfa](https://github.com/perzeuss/cloudflare-pages-mcp/commit/cbc8bfab56b6835d84d532b232726eff9a30dc5c))

# [1.1.0](https://github.com/perzeuss/cloudflare-pages-mcp/compare/v1.0.0...v1.1.0) (2026-05-31)


### Features

* opt-in CORS for the /upload endpoint (UPLOAD_ALLOWED_ORIGINS) ([#9](https://github.com/perzeuss/cloudflare-pages-mcp/issues/9)) ([9c104d4](https://github.com/perzeuss/cloudflare-pages-mcp/commit/9c104d4bb02c2bd40bf6166092e6c6bd589d064d))

# 1.0.0 (2026-05-31)


### Features

* Cloudflare Pages MCP server (create projects + deploy files) ([448f9ab](https://github.com/perzeuss/cloudflare-pages-mcp/commit/448f9abbba619a607961d4ec057098a20bc95f66))
* disk-based deploy workflow with batch upload URLs and upload skill ([#1](https://github.com/perzeuss/cloudflare-pages-mcp/issues/1)) ([e43cb8c](https://github.com/perzeuss/cloudflare-pages-mcp/commit/e43cb8c3717c64d4ca553157ff82a7158d6155ea))


### BREAKING CHANGES

* the server no longer speaks STDIO. Configure it as a remote
connector at POST /mcp and set OAUTH_PASSWORD (or MCP_AUTH_TOKEN) for auth.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* fix: align MCP tools and OAuth provider with the real Cloudflare client API

Repair the HTTP/OAuth port so it compiles and all tests pass:

- Rewrite src/mcp.ts to use the actual CloudflareClient API
  (createProject(name, branch), deploy({projectName, files, branch}),
  projectExists, collectFiles({files, directory})) and the existing inline /
  directory deploy schemas, preserving all five tools.
- Fix CloudflareClient.fromEnv() to read the new config fields
  (accountId / apiToken) and construct the shared client in app.ts the same way.
- Harden token parsing in src/security.ts for noUncheckedIndexedAccess.

typecheck, lint, format:check, build and the full test suite (42/42) pass.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* test: verify tools via an in-memory MCP session

The stateless Streamable HTTP transport requires an initialize handshake
before tools/list, which a single stateless HTTP request cannot satisfy.
Assert the five tools through buildMcpServer over an in-memory transport pair
instead, exercising the real MCP protocol without an HTTP session or any
Cloudflare network call. Full suite now passes 42/42.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* test: tolerate issuer URL normalization in OAuth discovery assertion

The MCP SDK normalizes the configured issuer URL (adds a trailing slash) in
the authorization-server metadata. Compare ignoring a trailing slash and also
assert the advertised PKCE method. Full suite now passes 42/42.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* fix: expose port instead of publishing it to avoid host port conflict

By default the compose service no longer binds a host port (which collided
with anything already on 0.0.0.0:3000). It only `expose`s 3000 on the Docker
network, where a reverse proxy reaches it as cloudflare-pages-mcp:3000. A
configurable host-port mapping (HOST_PORT) is provided as a commented-out
opt-in for local testing without a proxy.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* fix: remove server-side directory deploy; require inline files

The `deploy` tool accepted a `directory` path that `collectFiles` read from
the MCP server's own filesystem. That made sense for the original local stdio
server, but as a remote connector it walked the container's working directory
(/app) — so deploys without a usable path uploaded the server's own dist/ and
package.json instead of the intended site.

Drop `directory` entirely and require the complete site to be supplied inline
via a non-empty `files` array (text or base64). This removes the filesystem
disclosure/path-traversal surface and matches how a remote connector must work.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* feat: add staged (chunked) deployment for large sites

A remote connector receives every file as a tool argument, so a single
`deploy` call is bounded by the model's output-token limit — large sites with
many files or thousands of lines don't fit.

Add an incremental flow that splits the work across small calls and merges
them into ONE Cloudflare deployment:

- create_deployment -> returns a deploy_id
- add_files          -> append a small batch (call repeatedly)
- publish_deployment -> upload all staged files and go live

Staging state is held in an in-memory StagingStore with a TTL and a cap on
concurrent deployments. This is correct for a single instance; multiple
replicas would need a shared store (R2/KV). The single-call `deploy` tool is
kept for small sites.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* feat: signed direct-upload URLs for large binary assets

Binary assets (images, video, fonts) are impractical to pass inline: base64
inflates them ~33% and they must be produced as model output, so they blow the
per-call size limit.

Add create_upload_url: it returns a short-lived, HMAC-signed PUT URL (and a
ready curl -T command) targeting a staged deployment. An agent with shell
access streams the local file straight to the server, so the bytes never pass
through the model. The signed token in the path authorizes the upload, so the
route sits outside the MCP auth guard and is exempt from rate limiting.

- New PUT /upload/:token endpoint (raw body, capped at the 25 MiB file limit)
- Upload signing secret in config (UPLOAD_SIGNING_SECRET, falls back to
  OAUTH_SIGNING_SECRET, then an ephemeral per-process secret)
- Requires PUBLIC_BASE_URL so a reachable URL can be built
- Tests for valid/invalid token and unknown deploy_id; docs + .env.example

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* feat: add cloudflare-pages-upload skill for binary assets

Add a Claude skill that documents the staged-deploy + signed-upload workflow
and ships a small upload.sh helper. The script performs the one step the model
can't: streaming a local binary file from disk to a signed upload URL via
`curl -T` (single file or a TSV manifest of file/URL pairs), so image/video
bytes never pass through the model. The MCP tool calls themselves
(create_deployment, create_upload_url, publish_deployment) are driven by the
connector as usual.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* chore: install cloudflare-pages-upload skill under .claude/skills

Copy the skill into .claude/skills/ so it is auto-loaded when the repo is
opened in Claude Code, while keeping the canonical copy under skills/ as repo
documentation.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* feat: deprecate add_files, add batch upload URLs, clarify no-creds upload

Push the staged-deployment workflow fully onto disk-based uploads:

- create_upload_url now accepts a batch of `paths` and returns one signed URL
  per file plus a ready-to-use TSV manifest (single `path` still supported).
  This makes uploading a whole site from disk practical in one call.
- add_files is hard-deprecated: it no longer stages anything and instead
  returns instructions pointing at create_upload_url + the upload skill. Tool
  descriptions and the publish_deployment error message are updated to stop
  referring agents to add_files.
- Skill docs and upload.sh state explicitly that the upload needs NO Cloudflare
  credentials or env vars — the signed token in the URL is the authorization.
  CF_API_TOKEN / CF_ACCOUNT_ID / PROJECT_NAME are server-side only.

Tests cover batch + legacy create_upload_url output and the deprecated
add_files behavior (stages nothing).

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* docs: document disk-based deploy workflow and agent prompt in README

Rewrite the Tools list and deploy guidance for the new workflow: upload every
file from disk via create_upload_url (batch `paths`) + publish_deployment, and
mark add_files deprecated. Add a copy-paste agent prompt that installs the
cloudflare-pages-upload skill (downloads SKILL.md + upload.sh) and deploys a
site from disk without passing file contents through the model or setting any
CF_* env vars.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* style: apply prettier formatting to skill, README and mcp changes

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* fix: address CodeQL security findings in server and auth code

- app.ts: replace `contentSecurityPolicy: false` with a strict CSP. The only
  HTML surface is the OAuth consent page (inline <style>, posts to same origin),
  so default-src 'none' + style-src 'unsafe-inline' + form-action 'self' is
  enough and harmless for JSON responses.
- security.ts/oauth.ts: verify the OAuth password with a new scrypt-based
  verifyPassword (constant-time, expensive KDF) instead of a fast SHA-256
  digest. safeStrEqual stays for the bearer-token hot path (not a password).
- index.ts: log only the error message on fatal startup, never the raw thrown
  value, so configuration secrets can't leak into logs.
- Add unit tests for safeStrEqual and verifyPassword.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

* fix: don't interpolate OAuth issuer URL into thrown error

createApp threw an Error containing config.oauth.issuerUrl when the issuer was
not https; that value propagated up to the fatal handler in index.ts and was
logged, which CodeQL correctly flagged as clear-text logging of sensitive
config. Drop the value from the message and point at the env vars to fix
instead — this cuts the taint at its source rather than at the log sink.

https://claude.ai/code/session_01XdfsVe1y4YyywFekLHc7ki

# Changelog

All notable changes to this project are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/) and the
changelog is maintained automatically by
[semantic-release](https://semantic-release.gitbook.io/) on each release.

<!-- semantic-release will insert released versions below -->
