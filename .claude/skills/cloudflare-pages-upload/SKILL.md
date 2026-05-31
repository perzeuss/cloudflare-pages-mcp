---
name: cloudflare-pages-upload
description: >-
  Deploy a website to Cloudflare Pages via the cloudflare-pages-mcp connector,
  including large binary assets (images, video, fonts) that cannot be passed
  inline through tool calls. Use when the user wants to publish a site that
  includes local image/video/font files, or any deployment too large to send in
  a single deploy call.
---

# Cloudflare Pages: deploy sites with large binary assets

The `cloudflare-pages-mcp` connector deploys static sites to Cloudflare Pages.
Text files (HTML/CSS/JS) can be sent inline through tool calls, but **binary
assets** (images, video, fonts) cannot: base64 inflates them and they quickly
exceed the per-call size limit. This skill covers the workflow that uploads such
files **directly from disk**, so their bytes never pass through the model.

## When to use

- The site includes local binary files (images, video, fonts), **or**
- The site is large (many files / thousands of lines) and does not fit in a
  single `deploy` call.

For a small, all-text site, just call the `deploy` tool with inline `files` —
you don't need this skill.

## The tools (provided by the connector)

- `create_deployment` → starts a staged deployment, returns a `deploy_id`.
- `add_files` → appends a batch of **text** files inline (call repeatedly).
- `create_upload_url` → for one **binary** file: returns a short-lived signed
  `PUT` URL (and a ready `curl -T` command) bound to the `deploy_id` and a
  site path.
- `publish_deployment` → uploads everything staged and publishes it as ONE
  Cloudflare deployment; returns the live URL.

The server must have `PUBLIC_BASE_URL` configured for `create_upload_url` to
work (it needs a reachable host to build the URL).

## Workflow

1. **Start** a staged deployment:
   call `create_deployment` with `project_name` (and optionally `branch`).
   Keep the returned `deploy_id`.

2. **Add text files** (HTML/CSS/JS): call `add_files` with the `deploy_id` and a
   small batch of `{ path, content }` entries. Repeat for more files.

3. **Add each binary asset**: for every local image/video/font, call
   `create_upload_url` with the `deploy_id` and the target site `path`
   (e.g. `assets/hero.jpg`). It returns an upload URL. Then upload the local
   file with this skill's script (it runs `curl -T` for you):

   ```bash
   skills/cloudflare-pages-upload/upload.sh <local-file> "<upload-url>"
   ```

   To upload many at once, write a TSV manifest (one `local-file<TAB>upload-url`
   per line) and run:

   ```bash
   skills/cloudflare-pages-upload/upload.sh --manifest files.tsv
   ```

4. **Publish**: call `publish_deployment` with the `deploy_id`. It returns the
   live `*.pages.dev` URL.

## Notes

- The signed upload URL **is** the authorization for the `PUT`; no bearer token
  is needed for the upload itself.
- Upload URLs are short-lived (~30 min). Create them shortly before uploading.
- The same path can be overwritten by uploading again before publishing.
- Per-file limit is 25 MiB (Cloudflare Pages).
