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
  assert.equal(res.body.issuer, "https://example.com");
});

test("buildMcpServer registers the five Cloudflare Pages tools", async () => {
  // Drive the MCP server over an in-memory transport pair so we exercise the
  // real protocol (initialize + tools/list) without an HTTP session, and
  // without ever reaching the Cloudflare API.
  const client = new Client({ name: "test", version: "1.0" });
  const server = buildMcpServer({
    config: baseConfig,
    client: new CloudflareClient(baseConfig.accountId, baseConfig.apiToken),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_project",
    "delete_project",
    "deploy",
    "get_project",
    "list_projects",
  ]);

  await client.close();
  await server.close();
});
