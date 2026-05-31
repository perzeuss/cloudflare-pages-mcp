# Security Policy

## Reporting a vulnerability

Please report security issues **privately** rather than via public issues.

- Use GitHub's [private vulnerability reporting](https://github.com/perzeuss/cloudflare-pages-mcp/security/advisories/new)
  ("Report a vulnerability" under the repository's **Security** tab), or
- contact the maintainer directly at **[redacted]**.

Please include steps to reproduce and the affected version/commit. You'll get
an acknowledgement as soon as possible.

## Scope & hardening

This server holds your Cloudflare API token and can create, deploy and delete
Pages projects in your account, so handle its credentials with care:

- Never commit `.env` files or API tokens.
- The server reads all secrets from environment variables (see `.env.example`):
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Scope the Cloudflare API token to the minimum required permission
  (**Cloudflare Pages: Edit**).
- This is a local **stdio** server — it does not open any network listener.
  Treat the process environment as sensitive.

## Automated scanning

CI runs CodeQL (code), Dependency Review (PRs) and `npm audit` on production
dependencies.
