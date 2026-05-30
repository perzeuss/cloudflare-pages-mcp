/**
 * Minimal logger that writes exclusively to **stderr**.
 *
 * This is a stdio MCP server: stdout is reserved for the JSON-RPC protocol
 * stream, so anything we emit for humans (startup banners, diagnostics) must go
 * to stderr to avoid corrupting the transport.
 */

function emit(level: string, message: string, ...rest: unknown[]): void {
  const extra = rest.length
    ? " " + rest.map((r) => (r instanceof Error ? r.stack || r.message : String(r))).join(" ")
    : "";
  process.stderr.write(`[cloudflare-pages-mcp] ${level}: ${message}${extra}\n`);
}

export const logger = {
  info: (message: string, ...rest: unknown[]) => emit("info", message, ...rest),
  warn: (message: string, ...rest: unknown[]) => emit("warn", message, ...rest),
  error: (message: string, ...rest: unknown[]) => emit("error", message, ...rest),
};
