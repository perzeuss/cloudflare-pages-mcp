import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CloudflareClient, CloudflareError } from "../src/cloudflare.js";
import type { DeployFile } from "../src/files.js";

const realFetch = globalThis.fetch;

/** Wraps a Cloudflare-style success envelope in a JSON Response. */
function ok(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Wraps a Cloudflare-style error envelope in a JSON Response. */
function fail(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloudflareClient.fromEnv", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("throws a CloudflareError when credentials are missing", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    assert.throws(() => CloudflareClient.fromEnv(), CloudflareError);
  });

  it("builds a client when credentials are present", () => {
    process.env.CLOUDFLARE_API_TOKEN = "token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    assert.ok(CloudflareClient.fromEnv() instanceof CloudflareClient);
  });
});

describe("CloudflareClient API calls", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists projects via the account path", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return ok([{ name: "site", subdomain: "site.pages.dev", domains: [] }]);
    }) as unknown as typeof fetch;

    const cf = new CloudflareClient("acct", "token");
    const projects = await cf.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.name, "site");
    assert.match(calledUrl, /\/accounts\/acct\/pages\/projects$/);
  });

  it("sends the bearer token and parses Cloudflare errors", async () => {
    let authHeader = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      authHeader = new Headers(init.headers).get("Authorization") ?? "";
      return fail(403, 10000, "Authentication error");
    }) as unknown as typeof fetch;

    const cf = new CloudflareClient("acct", "token");
    await assert.rejects(() => cf.getProject("x"), /403.*Authentication error/);
    assert.equal(authHeader, "Bearer token");
  });

  it("treats a 404 as a non-existent project", async () => {
    globalThis.fetch = (async () => fail(404, 8000000, "not found")) as unknown as typeof fetch;
    const cf = new CloudflareClient("acct", "token");
    assert.equal(await cf.projectExists("missing"), false);
  });

  it("treats a successful lookup as an existing project", async () => {
    globalThis.fetch = (async () =>
      ok({ name: "site", subdomain: "site.pages.dev", domains: [] })) as unknown as typeof fetch;
    const cf = new CloudflareClient("acct", "token");
    assert.equal(await cf.projectExists("site"), true);
  });

  it("runs the full deploy flow, uploading only missing assets", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      calls.push(`${init.method ?? "GET"} ${path}`);

      if (path.endsWith("/upload-token")) return ok({ jwt: "jwt-token" });
      if (path === "/pages/assets/check-missing") {
        // Echo every requested hash back as "missing".
        const body = JSON.parse(String(init.body)) as { hashes: string[] };
        return ok(body.hashes);
      }
      if (path === "/pages/assets/upload") return ok(true);
      if (path === "/pages/assets/upsert-hashes") return ok(true);
      if (path.endsWith("/deployments")) {
        return ok({ id: "dep-1", url: "https://abc.site.pages.dev" });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const cf = new CloudflareClient("acct", "token");
    const files: DeployFile[] = [
      { path: "/index.html", contents: Buffer.from("<h1>hi</h1>") },
      { path: "/app.css", contents: Buffer.from("body{}") },
    ];
    const { deployment, uploaded, total } = await cf.deploy({ projectName: "site", files });

    assert.equal(deployment.id, "dep-1");
    assert.equal(deployment.url, "https://abc.site.pages.dev");
    assert.equal(total, 2);
    assert.equal(uploaded, 2);
    assert.ok(calls.some((c) => c.startsWith("POST /pages/assets/upload")));
    assert.ok(calls.some((c) => c.endsWith("/deployments")));
  });

  it("skips the upload call when no assets are missing", async () => {
    let uploadCalled = false;
    globalThis.fetch = (async (url: string) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      if (path.endsWith("/upload-token")) return ok({ jwt: "jwt" });
      if (path === "/pages/assets/check-missing") return ok([]); // nothing missing
      if (path === "/pages/assets/upload") {
        uploadCalled = true;
        return ok(true);
      }
      if (path === "/pages/assets/upsert-hashes") return ok(true);
      if (path.endsWith("/deployments")) return ok({ id: "d", url: "https://x.pages.dev" });
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;

    const cf = new CloudflareClient("acct", "token");
    const { uploaded } = await cf.deploy({
      projectName: "site",
      files: [{ path: "/index.html", contents: Buffer.from("hi") }],
    });
    assert.equal(uploaded, 0);
    assert.equal(uploadCalled, false);
  });
});
