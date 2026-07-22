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
import { MAX_FILE_SIZE, normalizePath } from "./files.js";
import { StatelessOAuthProvider } from "./oauth.js";
import { isOriginAllowed, safeStrEqual, verifyToken } from "./security.js";
import { StagingStore } from "./staging.js";

export type AuthMode = "oauth" | "token" | "open";

export interface CreatedApp {
  app: Express;
  authMode: AuthMode;
  /** The shared staging store backing chunked deployments. */
  staging: StagingStore;
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

  // Security headers. Responses must remain reachable cross-origin (Claude
  // connector traffic). A strict CSP still applies (default-src 'none'), but we
  // intentionally do NOT set `form-action`: the OAuth consent page posts to
  // /authorize and then redirects to the client's (cross-origin) redirect_uri.
  // `form-action` is a navigation directive that does not fall back to
  // default-src, so omitting it leaves form targets unrestricted (required for
  // the OAuth flow) without loosening any fetch restriction. A real policy
  // (rather than `contentSecurityPolicy: false`) still satisfies scanners.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'unsafe-inline'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
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
        // Don't rate-limit health checks, or signed asset uploads (a single
        // deploy may push many files and each PUT is already token-gated).
        skip: (req) => req.path === "/health" || req.path.startsWith("/upload/"),
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
      // Don't echo the configured URL into the error (it propagates to logs and
      // is part of the OAuth config) — point at the env vars to fix instead.
      throw new Error(
        "OAuth issuer URL must be an https:// URL (or localhost for testing). " +
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

  // Opt-in CORS (UPLOAD_ALLOWED_ORIGINS), shared by /health and /upload so a
  // browser-based agent on an opaque origin (Origin: null) can both verify the
  // server's CORS posture and upload. Off by default; "*" allows any origin —
  // safe here because no cookies are used and uploads are gated by the signed
  // token in the URL, so "*" exposes nothing the token wouldn't already.
  const corsOrigins = config.uploadAllowedOrigins ?? [];
  const applyCors = (req: Request, res: Response, methods: string): void => {
    if (corsOrigins.length === 0) return; // disabled
    const reqOrigin = req.headers.origin as string | undefined;
    let allowOrigin: string | undefined;
    if (corsOrigins.includes("*")) {
      allowOrigin = "*";
    } else if (reqOrigin && corsOrigins.includes(reqOrigin)) {
      allowOrigin = reqOrigin;
    }
    if (!allowOrigin) return; // origin present but not allow-listed
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", methods);
    // No credentials are used, so "*" is valid and avoids any header mismatch.
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Max-Age", "86400");
  };

  app.options("/health", (req, res) => {
    applyCors(req, res, "GET, OPTIONS");
    res.status(204).end();
  });
  app.get("/health", (req, res) => {
    applyCors(req, res, "GET, OPTIONS");
    res.json({
      status: "ok",
      auth: authMode,
      oauthIssuer: config.oauth?.issuerUrl,
    });
  });

  // --- Direct binary upload for staged deployments -------------------------
  // Large binary assets (images, video) are impractical to pass inline through
  // the model. Instead `create_upload_url` hands the agent a short-lived,
  // HMAC-signed URL; a shell tool (curl) streams the file straight here, so the
  // bytes never pass through the model. The signed token in the path IS the
  // auth for this route, so it is intentionally not behind the MCP auth guard.
  // CORS (for a browser-based uploader on an opaque origin) is the opt-in
  // UPLOAD_ALLOWED_ORIGINS policy shared with /health; see applyCors above.

  // Preflight for the cross-origin upload PUT (non-simple Content-Type).
  app.options("/upload/:token", (req: Request, res: Response) => {
    applyCors(req, res, "PUT, OPTIONS");
    res.status(204).end();
  });

  app.put(
    "/upload/:token",
    express.raw({ type: "*/*", limit: MAX_FILE_SIZE }),
    (req: Request, res: Response) => {
      applyCors(req, res, "PUT, OPTIONS");
      const tokenParam = req.params.token;
      const token = Array.isArray(tokenParam) ? (tokenParam[0] ?? "") : (tokenParam ?? "");
      const claims = verifyToken(token, config.uploadSigningSecret);
      if (!claims || claims.t !== "upload") {
        res.status(401).json({ error: "Invalid or expired upload token" });
        return;
      }
      const deployId = claims.did as string;
      const path = normalizePath(claims.p as string);
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        res.status(400).json({ error: "Empty request body. Send the file as the raw PUT body." });
        return;
      }
      try {
        const staged = staging.addFiles(deployId, [{ path, contents: body }]);
        res.json({
          status: "ok",
          path,
          bytes: body.byteLength,
          staged_files: staged.files.size,
        });
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

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

  return { app, authMode, staging };
}
