# Contributing

Thanks for your interest in improving **cloudflare-pages-mcp**!

## Development setup

```bash
nvm use            # Node 22 (see .nvmrc)
npm install
cp .env.example .env   # set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npm run dev            # run from source via tsx
```

This is a **stdio** MCP server: it speaks JSON-RPC over stdin/stdout. Remember
that **stdout is reserved for the protocol** — all human-facing logging must go
to stderr (see `src/logger.ts`).

Useful scripts:

| Script                                    | Purpose                        |
| ----------------------------------------- | ------------------------------ |
| `npm run build`                           | Compile TypeScript to `dist/`. |
| `npm test`                                | Run the test suite.            |
| `npm run test:coverage`                   | Run tests with coverage.       |
| `npm run typecheck`                       | Type-only check.               |
| `npm run lint`                            | ESLint.                        |
| `npm run format` / `npm run format:check` | Prettier write / check.        |

Please make sure `npm run format:check`, `npm run lint`, `npm run typecheck`,
`npm run build` and `npm test` all pass before opening a PR (CI runs the same).

## Coding conventions

- **TypeScript**, ES modules, strict mode.
- All configuration is read through `src/config.ts` — no scattered
  `process.env` access.
- Never write to **stdout** outside the MCP transport; use `src/logger.ts`.

## Commit messages — Conventional Commits

This repository uses [Conventional Commits](https://www.conventionalcommits.org/).
PRs are squash-merged, so the **PR title** becomes the commit message — it is
validated against Conventional Commits in CI. Please title your commits the
same way.

Format:

```
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`,
`build`, `perf`, `style`.

Breaking changes: add a `!` after the type/scope (`feat!: ...`) or a
`BREAKING CHANGE:` footer.

## Releases

Releases are automated with
[semantic-release](https://semantic-release.gitbook.io/). On every push to
`main`, the release workflow analyses commit messages and, when there's a
releasable change, bumps the version, updates `CHANGELOG.md`, and creates a Git
tag and a GitHub Release.

Version bumps follow the commit types: `fix` -> patch, `feat` -> minor,
`BREAKING CHANGE` -> major. Types like `chore`, `docs`, `ci`, `build`,
`refactor` and `test` don't trigger a release on their own.

## Dependencies

Dependabot opens grouped weekly PRs (one for GitHub Actions, one for non-major
npm updates; majors come individually). Non-major updates are **auto-merged**
after CI-equivalent verification — this requires **Settings -> General -> Allow
auto-merge** to be enabled. Major bumps are left for manual review.

## Pull requests

- Keep PRs focused and reasonably small.
- Add or update tests for behaviour changes.
- Update the README / `.env.example` when you add or change configuration.

## Reporting security issues

Please do **not** open public issues for security vulnerabilities — see
[SECURITY.md](./SECURITY.md).
