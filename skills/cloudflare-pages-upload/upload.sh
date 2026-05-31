#!/usr/bin/env bash
#
# Upload one or more local files to a Cloudflare Pages staged deployment using
# the signed upload URLs returned by the `create_upload_url` MCP tool.
#
# Why this exists: the MCP server is remote, so Claude cannot read local binary
# files (images, video, fonts) and pass them through a tool call. Instead it
# asks the server for a short-lived signed URL and uploads the file directly
# from disk with an HTTP PUT — the bytes never pass through the model.
#
# No credentials or environment variables are required: the signed token inside
# the upload URL is the authorization. Do NOT set CF_API_TOKEN / CF_ACCOUNT_ID /
# PROJECT_NAME — those are server-side settings, not needed by this script.
#
# Usage:
#   # Single file:
#   upload.sh <local-file> <upload-url>
#
#   # Many files from a manifest (TSV: "<local-file>\t<upload-url>" per line):
#   upload.sh --manifest <file>
#
# Exit code is non-zero if any upload fails.

set -euo pipefail

fail() {
  echo "error: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required but not installed."

put_one() {
  local file="$1" url="$2"
  [ -n "$file" ] || fail "missing local file path"
  [ -n "$url" ] || fail "missing upload URL"
  [ -f "$file" ] || fail "no such file: $file"
  case "$url" in
    http://*|https://*) ;;
    *) fail "upload URL must be http(s): $url" ;;
  esac

  echo "Uploading $file -> $url" >&2
  # -T streams the file as the raw PUT body; -f makes curl exit non-zero on
  # HTTP errors; capture the JSON response for visibility.
  local body status
  body="$(curl -fsS -X PUT -H "Content-Type: application/octet-stream" \
    --data-binary "@$file" "$url")" || fail "upload failed for $file"
  echo "$body"
}

if [ "${1:-}" = "--manifest" ]; then
  manifest="${2:-}"
  [ -n "$manifest" ] || fail "usage: upload.sh --manifest <file>"
  [ -f "$manifest" ] || fail "no such manifest: $manifest"
  while IFS=$'\t' read -r file url; do
    # Skip blank lines and comments.
    [ -z "${file// }" ] && continue
    case "$file" in \#*) continue ;; esac
    put_one "$file" "$url"
  done < "$manifest"
else
  [ "$#" -eq 2 ] || fail "usage: upload.sh <local-file> <upload-url>  |  upload.sh --manifest <file>"
  put_one "$1" "$2"
fi

echo "Done." >&2
