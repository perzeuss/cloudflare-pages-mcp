#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown: close the server so in-flight work can settle, then
  // exit. SIGINT/SIGTERM are the signals MCP clients send when stopping us.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    server
      .close()
      .catch((err) => logger.error("error during shutdown", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info("started on stdio transport");
  // Server runs until stdin closes; nothing else to do on the main thread.
}

main().catch((err) => {
  // stderr only — stdout is reserved for the JSON-RPC protocol stream.
  logger.error("fatal error starting cloudflare-pages-mcp", err);
  process.exit(1);
});
