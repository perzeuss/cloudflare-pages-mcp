import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CloudflareClient, CloudflareError } from "../src/cloudflare.js";
import { MAX_FILE_SIZE, type DeployFile } from "../src/files.js";

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

  for (const includePreview of [false, true]) {
    it(`patches only AI binding maps (includePreview=${includePreview})`, async () => {
      const cf = new CloudflareClient("acct", "token");
      const ai = { ai_bindings: { AI: {}, SEARCH_2: {} } };
      const expected = {
        deployment_configs: includePreview ? { production: ai, preview: ai } : { production: ai },
      };
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/acct/pages/projects/site");
        assert.equal(init?.method, "PATCH");
        assert.deepEqual(JSON.parse(String(init.body)), expected);
        return ok({ ...expected, name: "site" });
      };
      const result = await cf.setProjectBindings("site", ["AI", "SEARCH_2"], includePreview);
      assert.deepEqual(result.deployment_configs, expected.deployment_configs);
    });
  }

  it("rejects invalid AI binding names before making a request", async () => {
    globalThis.fetch = async () => assert.fail("unexpected API request");
    const cf = new CloudflareClient("acct", "token");
    for (const name of ["ai", "1AI", "_AI", "AI-2", "", "A".repeat(65)]) {
      await assert.rejects(cf.setProjectBindings("site", ["AI", name]), /AI binding name/);
    }
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

  it("sends the ES module bundle and routing configuration separately from assets", async () => {
    const source = "export default { fetch(request, env) { return env.ASSETS.fetch(request); } };";
    const routes = '{"version":1,"include":["/api/*"],"exclude":[]}';
    let form: FormData | undefined;
    let checked: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      if (path.endsWith("/upload-token")) return ok({ jwt: "jwt" });
      if (path === "/pages/assets/check-missing") {
        checked = (JSON.parse(String(init.body)) as { hashes: string[] }).hashes;
        return ok([]);
      }
      if (path === "/pages/assets/upsert-hashes") return ok(true);
      if (path.endsWith("/deployments")) {
        form = await new Response(init.body).formData();
        return ok({ id: "d", url: "https://x.pages.dev" });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;

    const cf = new CloudflareClient("acct", "token");
    const { total } = await cf.deploy({
      projectName: "site",
      files: [
        { path: "/index.html", contents: Buffer.from("hi") },
        { path: "/_headers", contents: Buffer.from("/*\n  X-Frame-Options: DENY\n") },
        { path: "/_redirects", contents: Buffer.from("/docs /en/docs/ 301\n") },
        { path: "/_worker.js", contents: Buffer.from(source) },
        { path: "/_routes.json", contents: Buffer.from(routes) },
        { path: "/sub/_headers", contents: Buffer.from("not config") },
      ],
    });

    assert.equal(total, 2);
    const manifest = JSON.parse(String(form!.get("manifest"))) as Record<string, string>;
    assert.deepEqual(Object.keys(manifest).sort(), ["/index.html", "/sub/_headers"]);
    assert.deepEqual(checked.sort(), Object.values(manifest).sort());
    assert.equal(await (form!.get("_headers") as File).text(), "/*\n  X-Frame-Options: DENY\n");
    assert.equal(await (form!.get("_redirects") as File).text(), "/docs /en/docs/ 301\n");
    assert.equal(await (form!.get("_routes.json") as File).text(), routes);
    assert.equal(form!.has("_worker.js"), false);
    const bundle = form!.get("_worker.bundle");
    assert.ok(bundle instanceof File);
    assert.equal(bundle.name, "_worker.bundle");
    // Wrangler's outer file carries the inner MIME boundary in its first line.
    const boundary = (await bundle.text()).split("\r\n")[0]!.slice(2);
    const parts = await new Response(bundle, {
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    }).formData();
    assert.deepEqual(JSON.parse(String(parts.get("metadata"))), { main_module: "_worker.js" });
    const entry = parts.get("_worker.js");
    assert.ok(entry instanceof File);
    assert.equal(entry.name, "_worker.js");
    assert.equal(entry.type, "application/javascript+module");
    assert.equal(await entry.text(), source);
  });

  it("rejects an oversized worker before asset upload", async () => {
    globalThis.fetch = async () => assert.fail("unexpected API request");
    const cf = new CloudflareClient("acct", "token");
    await assert.rejects(
      cf.deploy({
        projectName: "site",
        files: [{ path: "/_worker.js", contents: Buffer.alloc(MAX_FILE_SIZE + 1) }],
      }),
      /_worker\.js.*25 MiB/,
    );
  });

  it("rejects a worker directory before its modules reach asset upload", async () => {
    globalThis.fetch = async () => assert.fail("unexpected API request");
    const cf = new CloudflareClient("acct", "token");
    await assert.rejects(
      cf.deploy({
        projectName: "site",
        files: [{ path: "/_worker.js/index.js", contents: Buffer.from("export default {}") }],
      }),
      /single .* ES module/,
    );
  });

  it("omits the config fields when the site has none", async () => {
    let form: FormData | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      if (path.endsWith("/upload-token")) return ok({ jwt: "jwt" });
      if (path === "/pages/assets/check-missing") return ok([]);
      if (path === "/pages/assets/upsert-hashes") return ok(true);
      if (path.endsWith("/deployments")) {
        form = init.body as FormData;
        return ok({ id: "d", url: "https://x.pages.dev" });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as typeof fetch;
    const cf = new CloudflareClient("acct", "token");
    await cf.deploy({
      projectName: "site",
      files: [{ path: "/index.html", contents: Buffer.from("hi") }],
    });
    assert.deepEqual([...form!.keys()], ["manifest"]);
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
