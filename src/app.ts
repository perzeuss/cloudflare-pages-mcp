/**
 * Builds the Express application (without binding a port), so it can be both
 * started by index.ts and exercised by integration tests.
 */

import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import type { Config } from "./config.js";
import { CloudflareClient } from "./cloudflare.js";
import { buildMcpServer } from "./mcp.js";
import { StatelessOAuthProvider } from "./oauth.js";
import { isOriginAllowed, safeStrEqual } from "./security.js";
import { StagingStore } from "./staging.js";

export type AuthMode = "oauth" | "token" | "open";

export interface CreatedApp {
  app: Express;
  authMode: AuthMode;
}

/**
 * Construct the configured Express app and its shared Cloudflare client.
 */
export function createApp(config: Config): CreatedApp {
  const client = new CloudflareClient(config.accountId, config.apiToken);
  // Shared across requests so chunked deployments persist between tool calls.
  const staging = new StagingStore();

  const app = express();
  // Don't advertise the framework.
  app.disable("x-powered-by");
  // Honour X-Forwarded-* from the reverse proxy (needed for correct client IPs
  // in rate limiting and for building public links behind TLS termination).
  app.set("trust proxy", config.trustProxy);

  // Security headers. This is a JSON API, so CSP is disabled; responses must
  // remain reachable cross-origin (Claude connector traffic).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.use(express.json({ limit: config.maxBodySize }));

  // Per-IP rate limiting to contain abuse (0 = disabled).
  if (config.rateLimitMax > 0) {
    app.use(
      rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: config.rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        // Don't rate-limit health checks from orchestrators / uptime monitors.
        skip: (req) => req.path === "/health",
        message: {
          jsonrpc: "2.0",
          error: { code: -32029, message: "Too many requests" },
          id: null,
        },
      }),
    );
  }

  // Log OAuth-related requests so connector setup issues are diagnosable.
  // Registered before the auth router so it observes those requests.
  app.use((req, res, next) => {
    const path = req.path; // capture now; nested routers rewrite req.url later
    if (
      path === "/register" ||
      path === "/authorize" ||
      path === "/token" ||
      path.startsWith("/.well-known/")
    ) {
      const method = req.method;
      res.on("finish", () => console.log(`[oauth] ${method} ${path} -> ${res.statusCode}`));
    }
    next();
  });

  // Origin allow-list guard (applies regardless of the auth scheme).
  const originGuard: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    if (!isOriginAllowed(origin, config.allowedOrigins ?? [])) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Forbidden origin" },
        id: null,
      });
      return;
    }
    next();
  };

  // Legacy static bearer-token guard (used only when OAuth is disabled).
  const staticTokenGuard: RequestHandler = (req, res, next) => {
    if (!config.authToken) return next();
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token || !safeStrEqual(token, config.authToken)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    next();
  };

  // Choose the auth scheme: full OAuth 2.1 (for Claude connectors) when
  // OAUTH_PASSWORD is set, otherwise the optional static token / open access.
  let authMode: AuthMode;
  let mcpGuards: RequestHandler[];
  if (config.oauth) {
    const provider = new StatelessOAuthProvider(config.oauth);
    const issuerUrl = new URL(config.oauth.issuerUrl);
    const isLocal = issuerUrl.hostname === "localhost" || issuerUrl.hostname === "127.0.0.1";
    if (issuerUrl.protocol !== "https:" && !isLocal) {
      throw new Error(
        `OAuth issuer URL must be https (got "${config.oauth.issuerUrl}"). ` +
          "Set OAUTH_ISSUER_URL / PUBLIC_BASE_URL to your public https URL.",
      );
    }
    const resourceServerUrl = new URL("/mcp", issuerUrl);
    // Mount discovery, dynamic client registration, /authorize and /token.
    // resourceServerUrl makes the protected-resource metadata served at
    // /.well-known/oauth-protected-resource/mcp, matching the WWW-Authenticate
    // header below.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        resourceServerUrl,
        scopesSupported: [],
        resourceName: "Cloudflare Pages MCP",
      }),
    );
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
    mcpGuards = [originGuard, requireBearerAuth({ verifier: provider, resourceMetadataUrl })];
    authMode = "oauth";
  } else {
    mcpGuards = [originGuard, staticTokenGuard];
    authMode = config.authToken ? "token" : "open";
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      auth: authMode,
      oauthIssuer: config.oauth?.issuerUrl,
    });
  });

  // Stateless Streamable HTTP MCP endpoint.
  app.post("/mcp", ...mcpGuards, async (req: Request, res: Response) => {
    try {
      const server = buildMcpServer({ config, client, staging });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode does not support server-initiated streams / sessions.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return { app, authMode };
}
