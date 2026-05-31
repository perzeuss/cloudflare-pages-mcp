---
name: cloudflare-pages-upload
description: >-
  Deploy a website to Cloudflare Pages via the cloudflare-pages-mcp connector,
  uploading every file (HTML/CSS/JS and binary assets like images, video,
  fonts) directly from disk instead of passing content through the model. Use
  for any site that lives on disk, includes binary assets, or is too large for a
  single deploy call.
---

# Cloudflare Pages: deploy a site by uploading files from disk

The `cloudflare-pages-mcp` connector deploys static sites to Cloudflare Pages.
For a large site, or one that includes binary assets, the right approach is to
**upload every file straight from disk** via short-lived signed URLs, so file
bytes never pass through the model. This skill covers that workflow and ships an
`upload.sh` helper for the upload step.

> Note: the old `add_files` tool (passing file content inline) is **deprecated**
> and no longer stages anything. Use the workflow below instead.

## No credentials needed for the upload

**`upload.sh` needs NOTHING but the signed upload URL.** It just does an HTTP
`PUT` of your local file to the MCP server's `/upload/<token>` endpoint, and the
signed token in that URL *is* the authorization.

Do **NOT** set `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `PROJECT_NAME`, or any other
environment variable to run the script — those are server-side settings the MCP
server already holds; the client/script never sees Cloudflare credentials.

## When to use

- The site files exist on disk (a real project / build output), **or**
- The site includes binary assets (images, video, fonts), **or**
- The site is large (many files / thousands of lines) and won't fit in one
  `deploy` call.

For a small site whose files are entirely model-generated (not on disk), just
call the `deploy` tool with inline `files` — you don't need this skill.

## The tools (provided by the connector)

- `create_deployment` → starts a staged deployment, returns a `deploy_id`.
- `create_upload_url` → pass a **batch of `paths`**; returns one short-lived
  signed `PUT` URL per file, bound to the `deploy_id`, plus a ready-to-use
  manifest. (A single `path` is still accepted for one file.)
- `publish_deployment` → uploads everything staged and publishes it as ONE
  Cloudflare deployment; returns the live URL.

The server must have `PUBLIC_BASE_URL` configured for `create_upload_url` to
work (it needs a reachable host to build the URLs).

## Workflow

1. **Start** a staged deployment: call `create_deployment` with `project_name`
   (and optionally `branch`). Keep the returned `deploy_id`.

2. **Request upload URLs** for every file: call `create_upload_url` with the
   `deploy_id` and a `paths` array of all site-relative paths
   (e.g. `["index.html", "styles.css", "assets/hero.jpg"]`). It returns one
   signed URL per file and a TSV manifest block (`site-path <TAB> upload-url`).

3. **Upload from disk.** Save the manifest to a file. Where the local file path
   differs from the site path, replace the left column with the local path.
   Then run this skill's helper (no env vars, no credentials):

   ```bash
   skills/cloudflare-pages-upload/upload.sh --manifest files.tsv
   ```

   To upload a single file: `upload.sh <local-file> "<upload-url>"`
   (or directly: `curl -T <local-file> "<upload-url>"`).

4. **Publish**: call `publish_deployment` with the `deploy_id`. It returns the
   live `*.pages.dev` URL.

## Notes

- The signed upload URL **is** the authorization for the `PUT`; no bearer token
  and no Cloudflare credentials are needed for the upload.
- Upload URLs are short-lived (~30 min). Request them shortly before uploading.
- The same path can be overwritten by uploading again before publishing.
- Per-file limit is 25 MiB (Cloudflare Pages).
