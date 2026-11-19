import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CloudflareClient } from "../src/cloudflare.js";
import { ensureProjectAccess, resolveLoginIdps } from "../src/access.js";

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
    servicePolicy?: { id: string; decision: string; reusable?: boolean };
    badReadback?: boolean;
    forbidden?: boolean;
    pageTwo?: App[];
    providers?: { id: string; type: string; name?: string }[];
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
    if (path.startsWith("/identity_providers"))
      result = path.endsWith("page=1") ? (opts.providers ?? []) : [];
    else if (path.startsWith("/policies/"))
      result =
        path === `/policies/${opts.servicePolicy?.id}`
          ? opts.servicePolicy
          : (opts.policy ?? { id, decision: "allow", reusable: true });
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

test("operator-configured reusable Service Auth policies remain untouched", async () => {
  const serviceId = "597147a1-976b-4ef2-9af0-81d5d007fc34";
  const apps = ["site.pages.dev", "*.site.pages.dev", "private.example.com"].map((host) => ({
    ...app(host),
    policies: [{ id }, { id: serviceId }],
  }));
  const { client, calls } = mock({
    apps,
    servicePolicy: { id: serviceId, decision: "non_identity", reusable: true },
  });
  await ensureProjectAccess(client, project, id);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.equal(calls.filter((c) => c.path === `/policies/${serviceId}`).length, 3);
});

test("additional Bypass or Allow policies still prevent deployment", async () => {
  for (const decision of ["allow", "bypass"]) {
    const serviceId = "597147a1-976b-4ef2-9af0-81d5d007fc34";
    const { client } = mock({
      apps: [{ ...app("site.pages.dev"), policies: [{ id }, { id: serviceId }] }],
      servicePolicy: { id: serviceId, decision, reusable: true },
    });
    await assert.rejects(ensureProjectAccess(client, project, id), /exclusively/);
  }
});

const googleIdp = { id: "11111111-1111-4111-8111-111111111111", type: "google", name: "Google" };
const otpIdp = { id: "22222222-2222-4222-8222-222222222222", type: "onetimepin", name: "PIN" };
const githubIdp = { id: "33333333-3333-4333-8333-333333333333", type: "github" };
const login = { methods: ["google", "otp"] as ("google" | "otp")[] };
const hosts = ["site.pages.dev", "*.site.pages.dev", "private.example.com"];
const mutations = (calls: { method: string }[]) => calls.filter((c) => c.method !== "GET");

test("new applications are restricted to the enabled login methods", async () => {
  const { calls, client, apps } = mock({ providers: [githubIdp, googleIdp, otpIdp] });
  await ensureProjectAccess(client, project, id, login);
  assert.equal(apps.length, 3);
  for (const created of apps) assert.deepEqual(created.allowed_idps, [googleIdp.id, otpIdp.id]);
  // Providers are resolved before the first application is created.
  assert.ok(
    calls.findIndex((c) => c.path.startsWith("/identity_providers")) <
      calls.findIndex((c) => c.method === "POST"),
  );
});

test("a single enabled method only allows that provider", async () => {
  const { client, apps } = mock({ providers: [googleIdp, otpIdp] });
  await ensureProjectAccess(client, project, id, { methods: ["otp"] });
  for (const created of apps) assert.deepEqual(created.allowed_idps, [otpIdp.id]);
});

test("without login methods nothing changes: no provider lookup, no allowed_idps", async () => {
  const { calls, client, apps } = mock();
  await ensureProjectAccess(client, project, id);
  await ensureProjectAccess(client, project, id, { methods: [] });
  assert.ok(!calls.some((c) => c.path.startsWith("/identity_providers")));
  assert.ok(apps.every((created) => !("allowed_idps" in created)));
});

test("existing applications with exactly the enabled providers are reused untouched", async () => {
  const restricted = (domain: string) => ({
    ...app(domain),
    allowed_idps: [otpIdp.id, googleIdp.id],
  });
  const { calls, client } = mock({
    providers: [googleIdp, otpIdp],
    apps: hosts.map(restricted),
  });
  await ensureProjectAccess(client, project, id, login);
  assert.deepEqual(mutations(calls), []);
});

test("existing applications that allow other or all providers are rejected, not edited", async () => {
  for (const allowed of [undefined, [], [googleIdp.id], [googleIdp.id, otpIdp.id, githubIdp.id]]) {
    const { calls, client } = mock({
      providers: [googleIdp, otpIdp, githubIdp],
      apps: hosts.map((domain) => ({ ...app(domain), allowed_idps: allowed })),
    });
    await assert.rejects(
      () => ensureProjectAccess(client, project, id, login),
      /does not restrict login to the methods in ACCESS_LOGIN_METHODS/,
    );
    assert.deepEqual(mutations(calls), []);
  }
});

test("a missing identity provider aborts before any application is created", async () => {
  const { calls, client } = mock({ providers: [googleIdp] });
  await assert.rejects(
    () => ensureProjectAccess(client, project, id, login),
    /"otp" is enabled but no matching identity provider/,
  );
  assert.deepEqual(mutations(calls), []);
});

test("Google Workspace providers satisfy the google method", async () => {
  const workspace = { id: "44444444-4444-4444-8444-444444444444", type: "google-apps" };
  const { client, apps } = mock({ providers: [workspace] });
  await ensureProjectAccess(client, project, id, { methods: ["google"] });
  assert.deepEqual(apps[0]?.allowed_idps, [workspace.id]);
});

test("ambiguous providers need an explicit ID, which must have the right type", async () => {
  const second = { id: "55555555-5555-4555-8555-555555555555", type: "google" };
  const providers = [googleIdp, second, otpIdp];

  const ambiguous = mock({ providers });
  await assert.rejects(
    () => ensureProjectAccess(ambiguous.client, project, id, { methods: ["google"] }),
    /Set ACCESS_GOOGLE_IDP_ID/,
  );
  assert.deepEqual(mutations(ambiguous.calls), []);

  const chosen = mock({ providers });
  await ensureProjectAccess(chosen.client, project, id, {
    methods: ["google"],
    idpIds: { google: second.id },
  });
  assert.deepEqual(chosen.apps[0]?.allowed_idps, [second.id]);

  for (const wrong of [otpIdp.id, "66666666-6666-4666-8666-666666666666"]) {
    const bad = mock({ providers });
    await assert.rejects(
      () =>
        ensureProjectAccess(bad.client, project, id, {
          methods: ["google"],
          idpIds: { google: wrong },
        }),
      /ACCESS_GOOGLE_IDP_ID does not match/,
    );
    assert.deepEqual(mutations(bad.calls), []);
  }
});

test("identity providers are read across pages", async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    type: "github",
  }));
  const calls: string[] = [];
  const client = new CloudflareClient("account", "token", "https://api.test");
  client.accessRequest = (async (path: string) => {
    calls.push(path);
    // Match the page parameter exactly: "per_page=100" also contains "page=1".
    if (/[?&]page=1$/.test(path)) return many;
    return [otpIdp];
  }) as typeof client.accessRequest;
  assert.deepEqual(await resolveLoginIdps(client, ["otp"]), [otpIdp.id]);
  assert.equal(calls.length, 2);
});
