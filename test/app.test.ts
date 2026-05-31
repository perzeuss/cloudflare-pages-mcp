/**
 * Integration tests for the Express app, exercised with supertest.
 *
 * Network-touching dependencies (the Cloudflare API) are never called because
 * we only hit /health, the auth gate (401s happen before any tool runs) and
 * the MCP handshake (initialize / tools/list don't reach Cloudflare).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createApp } from "../src/app.ts";
import { buildMcpServer } from "../src/mcp.ts";
import { CloudflareClient } from "../src/cloudflare.ts";
import { StagingStore } from "../src/staging.ts";
import { signToken } from "../src/security.ts";
import type { Config } from "../src/config.ts";

const baseConfig: Config = {
  apiToken: "test-token",
  accountId: "test-account",
  apiBaseUrl: "https://api.test/client/v4",
  port: 3000,
  host: "127.0.0.1",
  trustProxy: 1,
  maxBodySize: "25mb",
  rateLimitWindowMs: 60000,
  rateLimitMax: 60,
  uploadSigningSecret: "test-upload-secret",
};

function makeApp(overrides: Partial<Config> = {}) {
  return createApp({ ...baseConfig, ...overrides });
}

test("GET /health returns ok and auth mode", async () => {
  const { app } = makeApp();
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.auth, "open");
});

test("PUT /upload with a valid token stages the file", async () => {
  const { app, staging } = makeApp();
  const { id } = staging.create({
    projectName: "p",
    createIfMissing: true,
    productionBranch: "main",
  });
  const token = signToken(
    { t: "upload", did: id, p: "/assets/logo.png" },
    baseConfig.uploadSigningSecret,
    600,
  );
  const res = await request(app)
    .put(`/upload/${token}`)
    .set("Content-Type", "application/octet-stream")
    .send(Buffer.from("PNGDATA"));
  assert.equal(res.status, 200);
  assert.equal(res.body.path, "/assets/logo.png");
  assert.equal(res.body.bytes, 7);
  assert.equal(staging.get(id).files.size, 1);
});

test("PUT /upload with an invalid token is rejected", async () => {
  const { app } = makeApp();
  const res = await request(app).put("/upload/not-a-real-token").send(Buffer.from("x"));
  assert.equal(res.status, 401);
});

test("PUT /upload for an unknown deploy_id returns 404", async () => {
  const { app } = makeApp();
  const token = signToken(
    { t: "upload", did: "missing", p: "/a.png" },
    baseConfig.uploadSigningSecret,
    600,
  );
  const res = await request(app)
    .put(`/upload/${token}`)
    .set("Content-Type", "application/octet-stream")
    .send(Buffer.from("x"));
  assert.equal(res.status, 404);
});

test("POST /mcp without token is unauthorized when token is set", async () => {
  const { app } = makeApp({ authToken: "secret" });
  const res = await request(app).post("/mcp").send({ jsonrpc: "2.0" });
  assert.equal(res.status, 401);
});

test("POST /mcp with correct token is reachable (initialize)", async () => {
  const { app } = makeApp({ authToken: "secret" });
  const res = await request(app)
    .post("/mcp")
    .set("Authorization", "Bearer secret")
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
  assert.equal(res.status, 200);
});

test("OAuth discovery endpoint responds when OAuth is configured", async () => {
  const { app, authMode } = makeApp({
    oauth: {
      issuerUrl: "https://example.com",
      password: "pw",
      signingSecret: "secret",
      accessTokenTtl: 3600,
      refreshTokenTtl: 2592000,
    },
  });
  assert.equal(authMode, "oauth");
  const res = await request(app).get("/.well-known/oauth-authorization-server");
  assert.equal(res.status, 200);
  // The SDK normalizes the issuer URL (may add a trailing slash).
  assert.equal(res.body.issuer.replace(/\/$/, ""), "https://example.com");
  assert.deepEqual(res.body.code_challenge_methods_supported, ["S256"]);
});

test("buildMcpServer registers the Cloudflare Pages tools", async () => {
  // Drive the MCP server over an in-memory transport pair so we exercise the
  // real protocol (initialize + tools/list) without an HTTP session, and
  // without ever reaching the Cloudflare API.
  const client = new Client({ name: "test", version: "1.0" });
  const server = buildMcpServer({
    config: baseConfig,
    client: new CloudflareClient(baseConfig.accountId, baseConfig.apiToken),
    staging: new StagingStore(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_files",
    "create_deployment",
    "create_project",
    "create_upload_url",
    "delete_project",
    "deploy",
    "get_project",
    "list_projects",
    "publish_deployment",
  ]);

  await client.close();
  await server.close();
});
