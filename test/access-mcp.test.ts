import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudflareClient } from "../src/cloudflare.js";
import { buildMcpServer } from "../src/mcp.js";
import { StagingStore } from "../src/staging.js";
import type { Config } from "../src/config.js";

const id = "f174e90a-fafe-4643-bbbc-4a0ed4fc8415";
const other = "597147a1-976b-4ef2-9af0-81d5d007fc34";
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
  accessPolicies: { private_pages: id },
  defaultAccessPolicyId: other,
};
class FakeCloudflare extends CloudflareClient {
  calls: string[] = [];
  apps: Record<string, unknown>[] = [];
  denyAccess = false;
  override async projectExists() {
    this.calls.push("exists");
    return true;
  }
  override async getProject() {
    return { name: "site", subdomain: "site.pages.dev", domains: [] };
  }
  override async createProject() {
    this.calls.push("create");
    return this.getProject();
  }
  override async accessRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.calls.push(path);
    if (this.denyAccess) throw new Error("Access permission denied");
    if (path.startsWith("/policies/"))
      return { id: path.slice(10), decision: "allow", reusable: true } as T;
    if (path.startsWith("/apps?")) return this.apps as T;
    if (init.method === "POST") {
      const app = { ...JSON.parse(String(init.body)), id: `app-${this.apps.length}` };
      this.apps.push(app);
      return app as T;
    }
    return this.apps.find((a) => a.id === path.slice(6)) as T;
  }
  override async deploy() {
    this.calls.push("UPLOAD");
    return {
      deployment: { id: "deployment", url: "https://abc.site.pages.dev" },
      uploaded: 1,
      total: 1,
    };
  }
}
async function connect(config: Config = base) {
  const cf = new FakeCloudflare("account", "token");
  const staging = new StagingStore();
  const server = buildMcpServer({ config, client: cf, staging });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    cf,
    staging,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
const text = (result: { content?: unknown }) => JSON.stringify(result.content);

test("agents discover and resolve named policies and the ENV default", async () => {
  const c = await connect();
  try {
    assert.match(
      text(await c.client.callTool({ name: "list_access_policies", arguments: {} })),
      /private_pages/,
    );
    assert.match(
      text(
        await c.client.callTool({
          name: "get_access_policy",
          arguments: { name: "private_pages" },
        }),
      ),
      new RegExp(id),
    );
    assert.match(
      text(await c.client.callTool({ name: "get_access_policy", arguments: {} })),
      new RegExp(other),
    );
  } finally {
    await c.close();
  }
});

for (const staged of [false, true]) {
  for (const named of [false, true]) {
    test(`${staged ? "staged" : "inline"} deployment protects before upload with ${named ? "named policy" : "default"}`, async () => {
      const c = await connect();
      try {
        const args = { project_name: "site", ...(named ? { access_policy: "private_pages" } : {}) };
        let result;
        if (staged) {
          const start = await c.client.callTool({ name: "create_deployment", arguments: args });
          const did = text(start).match(/deploy_id: ([a-f0-9-]+)/)![1]!;
          assert.equal(c.staging.get(did).accessPolicyId, named ? id : other);
          c.staging.addFiles(did, [{ path: "/index.html", contents: Buffer.from("test") }]);
          result = await c.client.callTool({
            name: "publish_deployment",
            arguments: { deploy_id: did },
          });
          assert.throws(() => c.staging.get(did), /Unknown/);
        } else
          result = await c.client.callTool({
            name: "deploy",
            arguments: { ...args, files: [{ path: "index.html", content: "test" }] },
          });
        assert.ok(!result.isError, text(result));
        assert.ok(
          c.cf.calls.indexOf(`/policies/${named ? id : other}`) < c.cf.calls.indexOf("UPLOAD"),
        );
        assert.equal(c.cf.apps.length, 2);
      } finally {
        await c.close();
      }
    });
  }
  test(`${staged ? "staged" : "inline"} Access errors prevent upload`, async () => {
    const c = await connect();
    c.cf.denyAccess = true;
    try {
      let result;
      if (staged) {
        const item = c.staging.create({
          projectName: "site",
          accessPolicyId: id,
          productionBranch: "main",
          createIfMissing: false,
        });
        c.staging.addFiles(item.id, [{ path: "/index.html", contents: Buffer.from("test") }]);
        result = await c.client.callTool({
          name: "publish_deployment",
          arguments: { deploy_id: item.id },
        });
        assert.ok(c.staging.get(item.id));
      } else
        result = await c.client.callTool({
          name: "deploy",
          arguments: { project_name: "site", files: [{ path: "index.html", content: "test" }] },
        });
      assert.equal(result.isError, true);
      assert.ok(!c.cf.calls.includes("UPLOAD"));
    } finally {
      await c.close();
    }
  });
}

test("unknown named policies fail before project creation or upload", async () => {
  const c = await connect();
  try {
    for (const name of ["create_project", "deploy", "create_deployment"]) {
      const result = await c.client.callTool({
        name,
        arguments: {
          name: "site",
          project_name: "site",
          access_policy: "missing",
          files: [{ path: "index.html", content: "test" }],
        },
      });
      assert.equal(result.isError, true);
    }
    assert.deepEqual(c.cf.calls, []);
  } finally {
    await c.close();
  }
});

test("create_project uses the default protection before returning", async () => {
  const c = await connect();
  try {
    const result = await c.client.callTool({ name: "create_project", arguments: { name: "site" } });
    assert.ok(!result.isError, text(result));
    assert.equal(c.cf.apps.length, 2);
  } finally {
    await c.close();
  }
});
