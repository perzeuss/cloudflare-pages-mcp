import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { protectedHosts } from "../src/access.js";
import { readAccessPolicies, readPublicDomains } from "../src/access-policies.js";
import { CloudflareClient, type DnsRecord, type PagesProject } from "../src/cloudflare.js";
import { buildMcpServer } from "../src/mcp.js";
import { StagingStore } from "../src/staging.js";
import type { Config } from "../src/config.js";

const policy = "d90d5dc3-334f-4c6f-b106-afad409acf5e";
const project: PagesProject = {
  name: "site",
  subdomain: "site.pages.dev",
  domains: ["site.pages.dev", "example.com", "intranet.example.com"],
};

test("only the listed custom domains are left open; pages.dev hosts always stay protected", () => {
  assert.deepEqual(protectedHosts(project), [
    "site.pages.dev",
    "*.site.pages.dev",
    "example.com",
    "intranet.example.com",
  ]);
  assert.deepEqual(protectedHosts(project, ["example.com"]), [
    "site.pages.dev",
    "*.site.pages.dev",
    "intranet.example.com",
  ]);
  assert.deepEqual(protectedHosts(project, ["site.pages.dev"]).slice(0, 2), [
    "site.pages.dev",
    "*.site.pages.dev",
  ]);
});

test("PUBLIC_DOMAINS is parsed strictly and defaults to none", () => {
  assert.deepEqual(readPublicDomains(undefined), {});
  assert.deepEqual(readPublicDomains(""), {});
  assert.deepEqual(
    readPublicDomains('{"site":[" Example.com ","example.com","xn--d1acj3b.xn--p1ai"]}'),
    {
      site: ["example.com", "xn--d1acj3b.xn--p1ai"],
    },
  );
  for (const bad of [
    "site",
    "[]",
    '{"Site":["example.com"]}',
    '{"site":[]}',
    '{"site":["*.example.com"]}',
    '{"site":["example.com:443"]}',
    '{"site":["other.pages.dev"]}',
    '{"__proto__":["example.com"]}',
  ]) {
    assert.throws(() => readPublicDomains(bad), bad);
  }
  assert.deepEqual(readAccessPolicies({}).publicDomains, {});
  assert.deepEqual(
    readAccessPolicies({ PUBLIC_DOMAINS: '{"site":["example.com"]}' }).publicDomains,
    { site: ["example.com"] },
  );
});

const base: Config = {
  apiToken: "token",
  accountId: "account",
  apiBaseUrl: "https://api.test",
  port: 3000,
  host: "localhost",
  trustProxy: 1,
  maxBodySize: "25mb",
  rateLimitWindowMs: 60000,
  rateLimitMax: 60,
  uploadSigningSecret: "secret",
  accessPolicies: { facet: policy },
  publicDomains: { site: ["example.com", "www.example.com"] },
};

class FakeCloudflare extends CloudflareClient {
  calls: string[] = [];
  records: DnsRecord[] = [];
  domains = ["site.pages.dev"];
  apps: Record<string, unknown>[] = [];
  autoRecord = false;
  failCreate = false;
  failDetach = false;
  failStatus = false;
  override async getProject(): Promise<PagesProject> {
    return { name: "site", subdomain: "site.pages.dev", domains: [...this.domains] };
  }
  override async projectExists() {
    return true;
  }
  override async findZone(hostname: string) {
    return hostname.endsWith("example.com") ? { id: "zone", name: "example.com" } : undefined;
  }
  override async listDnsRecords(_zone: string, name: string) {
    return this.records.filter((r) => r.name === name);
  }
  override async createDnsRecord(_zone: string, record: Omit<DnsRecord, "id">) {
    this.calls.push(`dns ${record.type} ${record.name} ${record.content} ${record.proxied}`);
    if (this.failCreate) throw new Error("Cloudflare API 403 on dns_records");
    const created = { id: "r", ...record };
    this.records.push(created);
    return created;
  }
  override async addProjectDomain(_project: string, domain: string) {
    this.calls.push(`attach ${domain}`);
    this.domains.push(domain);
    if (this.autoRecord)
      this.records.push({
        id: "auto",
        type: "CNAME",
        name: domain,
        content: "site.pages.dev",
        proxied: true,
      });
    return { name: domain, status: "initializing" };
  }
  override async deleteProjectDomain(_project: string, domain: string) {
    this.calls.push(`detach ${domain}`);
    if (this.failDetach) throw new Error("detach failed");
    this.domains = this.domains.filter((d) => d !== domain);
  }
  override async getProjectDomain(_project: string, domain: string) {
    if (this.failStatus) throw new Error("status failed");
    return { name: domain, status: "pending" };
  }
  override async accessRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (path.startsWith("/policies/"))
      return { id: path.slice(10), decision: "allow", reusable: true } as T;
    if (path.startsWith("/apps?")) return this.apps as T;
    if (init.method === "POST") {
      const app = { ...JSON.parse(String(init.body)), id: `app-${this.apps.length}` };
      this.calls.push(`access ${app.domain}`);
      this.apps.push(app);
      return app as T;
    }
    return this.apps.find((a) => a.id === path.slice(6)) as T;
  }
  override async deploy() {
    this.calls.push("UPLOAD");
    return { deployment: { id: "d", url: "https://abc.site.pages.dev" }, uploaded: 1, total: 1 };
  }
}

async function connect(config: Config = base) {
  const cf = new FakeCloudflare("account", "token");
  const server = buildMcpServer({ config, client: cf, staging: new StagingStore() });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { cf, client, close: () => Promise.all([client.close(), server.close()]) };
}
const text = (result: { content?: unknown }) => JSON.stringify(result.content);
const add = (domain = "example.com", project_name = "site") => ({
  name: "add_custom_domain",
  arguments: { project_name, domain },
});
const writes = (calls: string[]) => calls.filter((c) => /^(attach|dns|detach)/.test(c));

test("add_custom_domain attaches a listed domain and creates a proxied CNAME to pages.dev", async () => {
  const c = await connect();
  try {
    const result = await c.client.callTool(add("Example.com."));
    assert.ok(!result.isError, text(result));
    assert.deepEqual(c.cf.calls, [
      "attach example.com",
      "dns CNAME example.com site.pages.dev true",
    ]);
    assert.match(text(result), /created proxied CNAME/);
    assert.match(text(result), /No Cloudflare Access application covers https:\/\/example.com/);
  } finally {
    await c.close();
  }
});

test("add_custom_domain accepts a record Cloudflare created while attaching", async () => {
  const c = await connect();
  c.cf.autoRecord = true;
  try {
    const result = await c.client.callTool(add());
    assert.ok(!result.isError, text(result));
    assert.deepEqual(c.cf.calls, ["attach example.com"]);
    assert.match(text(result), /existing proxied CNAME/);
  } finally {
    await c.close();
  }
});

test("add_custom_domain refuses hosts the operator has not listed for the project", async () => {
  const c = await connect();
  try {
    for (const [domain, name] of [
      ["login.example.com", "site"],
      ["example.com", "other"],
      ["site.pages.dev", "site"],
    ] as const) {
      const result = await c.client.callTool(add(domain, name));
      assert.ok(result.isError, domain);
      assert.match(text(result), /PUBLIC_DOMAINS/);
    }
    assert.deepEqual(c.cf.calls, []);
  } finally {
    await c.close();
  }
});

test("add_custom_domain never replaces an address record and attaches nothing", async () => {
  const c = await connect();
  c.cf.records = [
    { id: "a", type: "A", name: "example.com", content: "192.0.2.1" },
    { id: "mx", type: "MX", name: "example.com", content: "mail.example.net" },
  ];
  try {
    const result = await c.client.callTool(add());
    assert.ok(result.isError);
    assert.match(text(result), /never replaces records/);
    assert.deepEqual(writes(c.cf.calls), []);
  } finally {
    await c.close();
  }
});

test("mail and verification records at the apex do not block the CNAME", async () => {
  const c = await connect();
  c.cf.records = [
    { id: "mx", type: "MX", name: "example.com", content: "mail.example.net" },
    { id: "txt", type: "TXT", name: "example.com", content: "v=spf1 -all" },
  ];
  try {
    const result = await c.client.callTool(add());
    assert.ok(!result.isError, text(result));
    assert.deepEqual(writes(c.cf.calls), [
      "attach example.com",
      "dns CNAME example.com site.pages.dev true",
    ]);
  } finally {
    await c.close();
  }
});

test("add_custom_domain refuses to override a wildcard that serves the host today", async () => {
  const c = await connect();
  c.cf.records = [
    { id: "w", type: "CNAME", name: "*.example.com", content: "ingress.example.net" },
  ];
  try {
    const result = await c.client.callTool(add("www.example.com"));
    assert.ok(result.isError);
    assert.match(text(result), /\*\.example\.com already serves www\.example\.com/);
    assert.deepEqual(writes(c.cf.calls), []);
  } finally {
    await c.close();
  }
});

test("a failed DNS write detaches the freshly attached domain", async () => {
  const c = await connect();
  c.cf.failCreate = true;
  try {
    const result = await c.client.callTool(add());
    assert.ok(result.isError);
    assert.match(text(result), /Detached example.com again/);
    assert.deepEqual(writes(c.cf.calls), [
      "attach example.com",
      "dns CNAME example.com site.pages.dev true",
      "detach example.com",
    ]);
    assert.ok(!c.cf.domains.includes("example.com"));
  } finally {
    await c.close();
  }
});

test("a failed detach reports exactly what was left behind", async () => {
  const c = await connect();
  c.cf.failCreate = true;
  c.cf.failDetach = true;
  try {
    const result = await c.client.callTool(add());
    assert.ok(result.isError);
    assert.match(text(result), /stays attached to \\"site\\" without a DNS record/);
  } finally {
    await c.close();
  }
});

test("a failed status read after both writes is reported as unknown, not as an error", async () => {
  const c = await connect();
  c.cf.failStatus = true;
  try {
    const result = await c.client.callTool(add());
    assert.ok(!result.isError, text(result));
    assert.match(text(result), /Domain status: unknown/);
  } finally {
    await c.close();
  }
});

test("an existing DNS-only CNAME is reported as DNS-only, and covering Access apps are named", async () => {
  const c = await connect();
  c.cf.domains.push("example.com");
  c.cf.records = [
    { id: "c", type: "CNAME", name: "example.com", content: "site.pages.dev", proxied: false },
  ];
  c.cf.apps = [
    { id: "x", name: "Corp wildcard", type: "self_hosted", domain: "*.example.com" },
    { id: "y", name: "Apex", type: "self_hosted", domain: "example.com" },
  ];
  try {
    const result = await c.client.callTool(add());
    assert.ok(!result.isError, text(result));
    assert.deepEqual(writes(c.cf.calls), []);
    assert.match(text(result), /Already attached/);
    assert.match(text(result), /existing DNS-only CNAME/);
    assert.match(text(result), /Still behind Cloudflare Access application\(s\): Apex/);
  } finally {
    await c.close();
  }
});

for (const [label, publicDomains, expected] of [
  [
    "listed",
    base.publicDomains,
    ["access site.pages.dev", "access *.site.pages.dev", "access intranet.example.com"],
  ],
  [
    "unlisted",
    {},
    [
      "access site.pages.dev",
      "access *.site.pages.dev",
      "access example.com",
      "access intranet.example.com",
    ],
  ],
] as const) {
  test(`a protected deploy of a ${label} project protects every host except the listed domains`, async () => {
    const c = await connect({ ...base, publicDomains: publicDomains as Record<string, string[]> });
    c.cf.domains.push("example.com", "intranet.example.com");
    try {
      const result = await c.client.callTool({
        name: "deploy",
        arguments: {
          project_name: "site",
          access_policy: "facet",
          files: [{ path: "index.html", content: "x" }],
        },
      });
      assert.ok(!result.isError, text(result));
      const access = c.cf.calls.filter((call) => call.startsWith("access "));
      assert.deepEqual(access, expected);
      assert.ok(c.cf.calls.indexOf(access.at(-1)!) < c.cf.calls.indexOf("UPLOAD"));
    } finally {
      await c.close();
    }
  });
}

// Real request paths and bodies of the new client methods, against a stubbed fetch.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stubFetch(answer: (url: string, init?: RequestInit) => unknown) {
  const seen: { url: string; method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ success: true, result: answer(url, init) }));
  }) as typeof fetch;
  return seen;
}

test("findZone prefers the longest matching zone of this account and never queries the TLD", async () => {
  const seen = stubFetch((url) => {
    const name = new URL(url).searchParams.get("name");
    if (name === "a.example.com") return [{ id: "foreign", name, account: { id: "other" } }];
    if (name === "example.com") return [{ id: "mine", name, account: { id: "account" } }];
    return [];
  });
  const cf = new CloudflareClient("account", "token", "https://api.test");
  assert.equal((await cf.findZone("www.a.example.com"))?.id, "mine");
  const names = seen.map((s) => new URL(s.url).searchParams.get("name"));
  assert.deepEqual(names, ["www.a.example.com", "a.example.com", "example.com"]);
  assert.ok(seen.every((s) => new URL(s.url).searchParams.get("account.id") === "account"));
  stubFetch(() => [{ id: "nameless", name: "example.com" }]);
  assert.equal(await cf.findZone("example.com"), undefined);
});

test("domain and DNS writes send the documented request bodies", async () => {
  const seen = stubFetch(() => ({ id: "r", name: "example.com" }));
  const cf = new CloudflareClient("account", "token", "https://api.test");
  await cf.addProjectDomain("site", "example.com");
  await cf.createDnsRecord("zone", {
    type: "CNAME",
    name: "example.com",
    content: "site.pages.dev",
    proxied: true,
  });
  await cf.deleteProjectDomain("site", "example.com");
  assert.deepEqual(seen, [
    {
      url: "https://api.test/accounts/account/pages/projects/site/domains",
      method: "POST",
      body: { name: "example.com" },
    },
    {
      url: "https://api.test/zones/zone/dns_records",
      method: "POST",
      body: {
        type: "CNAME",
        name: "example.com",
        content: "site.pages.dev",
        proxied: true,
        ttl: 1,
      },
    },
    {
      url: "https://api.test/accounts/account/pages/projects/site/domains/example.com",
      method: "DELETE",
      body: undefined,
    },
  ]);
});
