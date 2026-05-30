#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes; nothing else to do on the main thread.
}

main().catch((err) => {
  // stderr only — stdout is reserved for the JSON-RPC protocol stream.
  console.error("Fatal error starting cloudflare-pages-mcp:", err);
  process.exit(1);
});
