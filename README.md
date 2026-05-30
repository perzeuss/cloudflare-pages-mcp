# cloudflare-pages-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant
(e.g. Claude) **create Cloudflare Pages projects and deploy files to a live
`*.pages.dev` site**. Hand it Claude-generated HTML/CSS/JS and it publishes a
real, public web page.

It talks directly to the Cloudflare REST API using the same
[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
flow that Wrangler uses (asset hashing → `check-missing` → asset upload →
deployment), so there is no Wrangler dependency and no subprocess — just the
API.

## Tools

| Tool             | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `create_project` | Create an empty Direct Upload project (`<name>.pages.dev`).        |
| `deploy`         | Upload files and publish a deployment. Auto-creates the project.   |
| `list_projects`  | List all Pages projects in the account.                            |
| `get_project`    | Show one project's live URL, custom domains and production branch. |
| `delete_project` | Permanently delete a project and its deployments.                  |

### `deploy`

Accepts files **inline** and/or from a local **directory** (walked
recursively; inline files win on path conflicts):

```jsonc
{
  "project_name": "my-landing-page",
  "files": [
    { "path": "index.html", "content": "<!doctype html><h1>Hello</h1>" },
    { "path": "assets/logo.png", "content": "<base64…>", "encoding": "base64" },
  ],
  // or: "directory": "/abs/path/to/site"
  // "branch": "preview"   // omit for a production deploy
}
```

Returns the deployment URL and the production `https://<name>.pages.dev` URL.

Limits (enforced by Cloudflare): up to **20,000 files**, **25 MiB** per file.

## Setup

Requires Node.js ≥ 22 (see `.nvmrc`).

```bash
npm install
npm run build
```

### Credentials

Set two environment variables (see `.env.example`):

- `CLOUDFLARE_API_TOKEN` — a token with the **Cloudflare Pages: Edit**
  permission ([create one here](https://dash.cloudflare.com/profile/api-tokens)).
- `CLOUDFLARE_ACCOUNT_ID` — your account ID (Workers & Pages → Account details).

## Use with Claude

Add to your MCP client config (e.g. Claude Desktop
`claude_desktop_config.json`, or `.mcp.json` for Claude Code):

```jsonc
{
  "mcpServers": {
    "cloudflare-pages": {
      "command": "node",
      "args": ["/abs/path/to/cloudflare-pages-mcp/dist/index.js"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "…",
        "CLOUDFLARE_ACCOUNT_ID": "…",
      },
    },
  },
}
```

Then ask Claude to design a page and deploy it — it will call `deploy` and give
you back the live URL.

## Docker

The image is a stdio MCP server (no ports). Pass the credentials as environment
variables and keep stdin/stdout attached for the JSON-RPC transport:

```bash
docker build -t cloudflare-pages-mcp .
docker run --rm -i \
  -e CLOUDFLARE_API_TOKEN=… \
  -e CLOUDFLARE_ACCOUNT_ID=… \
  cloudflare-pages-mcp
```

A prebuilt image is published to `ghcr.io/perzeuss/cloudflare-pages-mcp`.

## Development

```bash
npm run dev          # run from source via tsx
npm run typecheck
npm run lint
npm run format
npm test             # node:test suite
npm run test:coverage
```

This is a **stdio** server: stdout carries the JSON-RPC protocol, so all logging
goes to **stderr** via `src/logger.ts`. Configuration is validated centrally in
`src/config.ts`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and the
[Conventional Commits](https://www.conventionalcommits.org/) /
[semantic-release](https://semantic-release.gitbook.io/) conventions this
project follows.

## License

[MIT](LICENSE) © Pascal Malbranche
