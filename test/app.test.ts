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

import { createApp } from "../src/app.ts";
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

test("tools/list returns the five Cloudflare Pages tools", async () => {
  const { app } = makeApp();
  const res = await request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
  assert.equal(res.status, 200);
  // Streamable HTTP returns the JSON-RPC payload as an SSE event; the tool
  // names appear in the response body regardless of framing.
  const body = res.text;
  for (const tool of [
    "create_project",
    "deploy",
    "list_projects",
    "get_project",
    "delete_project",
  ]) {
    assert.ok(body.includes(tool), `expected tools/list to include ${tool}`);
  }
});
