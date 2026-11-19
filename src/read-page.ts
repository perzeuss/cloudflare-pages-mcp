import type { Config } from "./config.js";
import type { CloudflareClient } from "./cloudflare.js";

const MAX_BYTES = 1024 * 1024;

/** Fetch only an account-owned project's canonical production hostname. */
export async function readProjectPage(
  client: CloudflareClient,
  config: Pick<Config, "accessServiceToken">,
  projectName: string,
  path = "/",
): Promise<{ url: string; status: number; content_type: string; content: string }> {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n\0]/.test(path)) {
    throw new Error("Provide a site-relative path starting with a single /.");
  }
  const project = await client.getProject(projectName);
  const host = project.subdomain || `${project.name}.pages.dev`;
  if (!/^[a-z0-9][a-z0-9-]*\.pages\.dev$/.test(host)) {
    throw new Error("Cannot read an invalid production pages.dev hostname.");
  }
  const origin = `https://${host}`;
  const url = new URL(path, origin);
  if (url.origin !== origin)
    throw new Error("Only this project's production hostname may be read.");
  url.hash = "";

  const headers: Record<string, string> = {
    Accept: "text/*, application/json, application/javascript, application/xml",
  };
  const token = config.accessServiceToken;
  if (token) {
    headers["CF-Access-Client-Id"] = token.clientId;
    headers["CF-Access-Client-Secret"] = token.clientSecret;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new Error(
        controller.signal.aborted ? "Page request timed out." : "Page request failed.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Page returned HTTP ${response.status}. Redirects are not followed; check the path and the existing Cloudflare Service Auth configuration.`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !/^(text\/[^;]+|application\/(?:json|[^;]+\+json|javascript|xml|[^;]+\+xml)|image\/svg\+xml)(?:;|$)/i.test(
        contentType,
      )
    ) {
      await response.body?.cancel();
      throw new Error("read_page supports text content only.");
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new Error("Page exceeds the 1 MiB read limit.");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            throw new Error("Page exceeds the 1 MiB read limit.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let content = Buffer.concat(chunks).toString("utf8");
    if (token) {
      content = content
        .replaceAll(token.clientSecret, "[redacted]")
        .replaceAll(token.clientId, "[redacted]");
    }
    return { url: url.href, status: response.status, content_type: contentType, content };
  } finally {
    clearTimeout(timer);
  }
}
