import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CloudflareClient } from "../src/cloudflare.js";
import { ensureProjectAccess } from "../src/access.js";

const id = "f174e90a-fafe-4643-bbbc-4a0ed4fc8415";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const project = { name: "site", subdomain: "site.pages.dev", domains: ["private.example.com"] };
type App = {
  id: string;
  domain: string;
  type: string;
  policies: { id: string }[];
  [key: string]: unknown;
};
const app = (domain: string, key = domain): App => ({
  id: key,
  domain,
  type: "self_hosted",
  policies: [{ id }],
});
function mock(
  opts: {
    apps?: App[];
    policy?: unknown;
    badReadback?: boolean;
    forbidden?: boolean;
    pageTwo?: App[];
  } = {},
) {
  const apps = opts.apps ?? [];
  const calls: { path: string; method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    const path = String(url).split("/access")[1]!;
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    let result: unknown;
    if (opts.forbidden)
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 10000, message: "forbidden" }] }),
        { status: 403 },
      );
    if (path.startsWith("/policies/"))
      result = opts.policy ?? { id, decision: "allow", reusable: true };
    else if (path.startsWith("/apps?"))
      result = path.endsWith("page=2") ? (opts.pageTwo ?? []) : apps;
    else if (path === "/apps" && method === "POST") {
      const data = JSON.parse(String(init.body));
      const created = { ...data, id: `app-${apps.length}` };
      apps.push(created);
      result = created;
    } else if (path.startsWith("/apps/")) {
      result = apps
        .concat(opts.pageTwo ?? [])
        .find((a) => a.id === decodeURIComponent(path.slice(6)));
      if (opts.badReadback) result = { ...(result as App), policies: [] };
    } else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify({ success: true, result }));
  }) as typeof fetch;
  return { calls, apps, client: new CloudflareClient("account", "token", "https://api.test") };
}

test("creates and reads back protection for production, wildcard deployments and custom domains", async () => {
  const { calls, client, apps } = mock();
  assert.deepEqual(await ensureProjectAccess(client, project, id), [
    "site.pages.dev",
    "*.site.pages.dev",
    "private.example.com",
  ]);
  assert.equal(apps.length, 3);
  assert.equal(calls.filter((c) => c.method === "POST").length, 3);
  assert.equal(calls.filter((c) => c.path.startsWith("/apps/")).length, 3);
  assert.deepEqual(apps[0]?.policies, [{ id, precedence: 1 }]);
});

test("reuses existing applications without changing operator settings", async () => {
  const { calls, client } = mock({
    apps: [app("site.pages.dev"), app("*.site.pages.dev"), app("private.example.com")],
  });
  await ensureProjectAccess(client, project, id);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("rejects non-Allow, foreign and non-reusable policy IDs", async () => {
  for (const policy of [
    { id, decision: "bypass", reusable: true },
    { id: "other", decision: "allow", reusable: true },
    { id, decision: "allow", reusable: false },
  ]) {
    const { client, calls } = mock({ policy });
    await assert.rejects(ensureProjectAccess(client, project, id), /reusable Allow/);
    assert.equal(calls.length, 1);
  }
});

test("rejects overlapping hostname/path applications and additional policies", async () => {
  for (const apps of [
    [app("site.pages.dev/public")],
    [app("*.pages.dev")],
    [app("abc.site.pages.dev")],
    [app("site.pages.dev", "a"), app("site.pages.dev", "b")],
    [{ ...app("site.pages.dev"), policies: [{ id }, { id: "other" }] }],
    [{ ...app("site.pages.dev"), options_preflight_bypass: true }],
    [
      {
        ...app("site.pages.dev"),
        destinations: [
          {
            type: "public",
            uri: "site.pages.dev",
            overrides: [{ behavior: "public", path_pattern: "*" }],
          },
        ],
      },
    ],
  ]) {
    const { client } = mock({ apps });
    await assert.rejects(ensureProjectAccess(client, project, id), /Overlapping|exclusively/);
  }
});

test("readback failures and API permission errors abort protection", async () => {
  for (const options of [{ badReadback: true }, { forbidden: true }]) {
    const { client } = mock(options);
    await assert.rejects(ensureProjectAccess(client, project, id), /exclusively|403/);
  }
});

test("checks all pages of Access applications for conflicting rules", async () => {
  const { client } = mock({
    apps: Array.from({ length: 100 }, (_, i) => app(`unrelated${i}.example.net`)),
    pageTwo: [app("site.pages.dev/public")],
  });
  await assert.rejects(ensureProjectAccess(client, project, id), /Overlapping/);
});
