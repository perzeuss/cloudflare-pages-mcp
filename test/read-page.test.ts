import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readProjectPage } from "../src/read-page.js";
import { CloudflareClient } from "../src/cloudflare.js";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const token = { clientId: "reader.access", clientSecret: "secret-test-value" };
class ProjectClient extends CloudflareClient {
  override async getProject() {
    return { name: "site", subdomain: "site.pages.dev", domains: ["private.example.com"] };
  }
}
const client = new ProjectClient("account", "management-token");

test("read_page uses GET and server credentials only for the canonical project hostname", async () => {
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://site.pages.dev/test/");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("CF-Access-Client-Id"), token.clientId);
    assert.equal(headers.get("CF-Access-Client-Secret"), token.clientSecret);
    assert.equal(headers.get("Authorization"), null);
    return new Response("<h1>hello</h1>", { headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  const result = await readProjectPage(client, { accessServiceToken: token }, "site", "/test/");
  assert.equal(result.content, "<h1>hello</h1>");
});

test("public reads work without changing existing policy configuration or sending credentials", async () => {
  globalThis.fetch = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("CF-Access-Client-Secret"), null);
    return new Response('{"hello":true}', { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  assert.equal((await readProjectPage(client, {}, "site")).content, '{"hello":true}');
});

test("arbitrary URLs and hostname changes are rejected without requesting them", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("must not fetch");
  }) as typeof fetch;
  for (const path of ["https://evil.example", "//evil.example", "/\\evil.example", "/\r\nevil"]) {
    await assert.rejects(readProjectPage(client, {}, "site", path), /site-relative/);
  }
  class InvalidProject extends ProjectClient {
    override async getProject() {
      return { name: "site", subdomain: "localhost", domains: [] };
    }
  }
  await assert.rejects(
    readProjectPage(new InvalidProject("account", "token"), {}, "site"),
    /invalid/,
  );
  assert.equal(fetched, false);
});

test("redirects and denied requests do not leak credentials or response bodies", async () => {
  for (const status of [302, 401, 403, 404]) {
    let count = 0;
    globalThis.fetch = (async () => {
      count++;
      return new Response(token.clientSecret, {
        status,
        headers: { Location: "https://evil.example" },
      });
    }) as typeof fetch;
    await assert.rejects(
      readProjectPage(client, { accessServiceToken: token }, "site"),
      (err: Error) => {
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        assert.ok(!err.message.includes(token.clientSecret));
        return true;
      },
    );
    assert.equal(count, 1);
  }
});

test("binary and oversized responses are rejected, including streamed bodies without content-length", async () => {
  for (const response of [
    new Response("PNG", { headers: { "Content-Type": "image/png" } }),
    new Response("text", {
      headers: { "Content-Type": "text/plain", "Content-Length": String(1024 * 1024 + 1) },
    }),
    new Response("x".repeat(1024 * 1024 + 1), { headers: { "Content-Type": "text/plain" } }),
  ]) {
    globalThis.fetch = (async () => response) as typeof fetch;
    await assert.rejects(readProjectPage(client, {}, "site"), /text content|1 MiB/);
  }
});

test("reflected credentials and network error details are not returned", async () => {
  globalThis.fetch = (async () =>
    new Response(`${token.clientId} ${token.clientSecret}`, {
      headers: { "Content-Type": "text/plain" },
    })) as typeof fetch;
  assert.equal(
    (await readProjectPage(client, { accessServiceToken: token }, "site")).content,
    "[redacted] [redacted]",
  );
  globalThis.fetch = (async () => {
    throw new Error(token.clientSecret);
  }) as typeof fetch;
  await assert.rejects(
    readProjectPage(client, { accessServiceToken: token }, "site"),
    /^Error: Page request failed\.$/,
  );
});

test("project lookup errors prevent content requests", async () => {
  class MissingProject extends ProjectClient {
    override async getProject(): ReturnType<ProjectClient["getProject"]> {
      throw new Error("Project not found");
    }
  }
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  await assert.rejects(
    readProjectPage(new MissingProject("account", "token"), {}, "missing"),
    /Project not found/,
  );
});
