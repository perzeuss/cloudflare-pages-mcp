#!/usr/bin/env node
/**
 * Remote MCP server for Cloudflare Pages.
 *
 * Exposes:
 *   - POST /mcp     Streamable HTTP MCP endpoint (use this URL as the Claude
 *                   custom connector URL).
 *   - GET  /health  Health check.
 *
 * The Express app itself is built in app.ts (so it can be tested); this file
 * just wires configuration, binds the port and handles graceful shutdown.
 */

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

function main() {
  const config = loadConfig();
  const { app, authMode } = createApp(config);

  const server = app.listen(config.port, config.host, () => {
    console.log(`cloudflare-pages-mcp listening on http://${config.host}:${config.port}`);
    console.log(`  MCP endpoint:   POST /mcp`);
    console.log(`  Health:         GET  /health`);
    if (config.publicBaseUrl) {
      console.log(`  Public base:    ${config.publicBaseUrl}`);
    } else {
      console.log(
        "  Public base:    (set PUBLIC_BASE_URL to your public https URL for connectors)",
      );
    }
    const authLabel = {
      oauth: `OAuth 2.1 (issuer ${config.oauth?.issuerUrl})`,
      token: "static bearer token",
      open: "open (no auth)",
    }[authMode];
    console.log(`  Auth:           ${authLabel}`);
    console.log(
      `  Rate limit:     ${config.rateLimitMax > 0 ? `${config.rateLimitMax}/${config.rateLimitWindowMs}ms per IP` : "disabled"}`,
    );
  });

  // Graceful shutdown so in-flight requests can finish on redeploys.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (err) {
  // Log only the error message, never the raw thrown value — the latter could
  // embed configuration (e.g. OAuth secrets). A startup failure stays
  // diagnosable without leaking sensitive data to logs.
  console.error(`Fatal: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
}
