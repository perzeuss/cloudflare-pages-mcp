/**
 * Central configuration, loaded entirely from environment variables so the
 * server can be configured for any deployment (Docker, local, managed hosts)
 * without code changes.
 *
 * The Cloudflare credentials are validated fail-loud here; the HTTP server and
 * OAuth settings are layered on so the same server can run as a remote Claude
 * custom connector.
 */

import { randomBytes } from "node:crypto";

import { parseList } from "./security.js";

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * OAuth 2.1 authorization-server configuration. Enabled by setting
 * OAUTH_PASSWORD; required for using the server as a Claude custom connector
 * (Claude authenticates connectors via OAuth + dynamic client registration).
 */
export interface OAuthConfig {
  /** Public HTTPS issuer/base URL of this server (also the resource id). */
  issuerUrl: string;
  /** Shared password the user enters on the consent screen. */
  password: string;
  /** HMAC secret used to sign stateless authorization codes and tokens. */
  signingSecret: string;
  /** Access-token lifetime in seconds. */
  accessTokenTtl: number;
  /** Refresh-token lifetime in seconds. */
  refreshTokenTtl: number;
}

export interface Config {
  // --- Cloudflare credentials (required) ---
  /** Cloudflare API token with Pages edit permission. */
  apiToken: string;
  /** Cloudflare account ID that owns the Pages projects. */
  accountId: string;
  /** Base URL for the Cloudflare API (override for testing). */
  apiBaseUrl: string;

  // --- HTTP server ---
  /** HTTP port the server listens on. */
  port: number;
  /** Host/interface to bind to. */
  host: string;
  /** Public base URL this server is reachable at (also the OAuth issuer). */
  publicBaseUrl?: string;

  // --- Security / hardening ---
  /**
   * Express "trust proxy" setting. A number of proxy hops to trust (default 1,
   * suitable for a single reverse proxy) is recommended over `true`, which is
   * permissive and lets clients spoof X-Forwarded-For to bypass rate limiting.
   */
  trustProxy: boolean | number;
  /** Max accepted JSON request body size (Express byte-size string). */
  maxBodySize: string;
  /** Rate-limit window in milliseconds. */
  rateLimitWindowMs: number;
  /** Max requests per window per client IP (0 disables rate limiting). */
  rateLimitMax: number;
  /** Optional allow-list of request Origin headers for the MCP endpoint. */
  allowedOrigins?: string[];
  /**
   * Optional CORS allow-list for the direct-upload endpoint. Empty/undefined
   * disables CORS (server-to-server `curl` only). `["*"]` allows any origin
   * (safe: the signed token is the auth and no cookies are used). Otherwise,
   * only the listed origins may upload from a browser.
   */
  uploadAllowedOrigins?: string[];
  /** Optional bearer token. If set, every MCP request must send it. */
  authToken?: string;
  /** HMAC secret used to sign short-lived direct-upload URLs. */
  uploadSigningSecret: string;
  /** OAuth authorization server, enabled when OAUTH_PASSWORD is set. */
  oauth?: OAuthConfig;
}

/**
 * Build the OAuth config when OAUTH_PASSWORD is set. Requires a public HTTPS
 * issuer URL (OAUTH_ISSUER_URL or PUBLIC_BASE_URL). Fails loudly on
 * misconfiguration instead of silently leaving the connector unauthenticated.
 */
export function readOAuthConfig(): OAuthConfig | undefined {
  const password = process.env.OAUTH_PASSWORD?.trim();
  if (!password) return undefined;

  const issuerUrl = (process.env.OAUTH_ISSUER_URL || process.env.PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!issuerUrl) {
    throw new Error(
      "OAuth is enabled (OAUTH_PASSWORD set) but no issuer URL is configured. " +
        "Set OAUTH_ISSUER_URL (or PUBLIC_BASE_URL) to this server's public URL.",
    );
  }

  let signingSecret = process.env.OAUTH_SIGNING_SECRET?.trim();
  if (!signingSecret) {
    signingSecret = randomBytes(32).toString("hex");
    console.warn(
      "[config] OAUTH_SIGNING_SECRET not set — generated an ephemeral one. " +
        "Existing tokens are invalidated on restart and multiple instances " +
        "won't share tokens. Set OAUTH_SIGNING_SECRET for production.",
    );
  }

  return {
    issuerUrl,
    password,
    signingSecret,
    accessTokenTtl: Number.parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL || "3600", 10),
    refreshTokenTtl: Number.parseInt(process.env.OAUTH_REFRESH_TOKEN_TTL || "2592000", 10),
  };
}

/**
 * Parse the TRUST_PROXY env var. Accepts a number of hops, or `true`/`false`.
 * Defaults to 1 (a single reverse proxy) — not `true`, which is permissive and
 * lets clients spoof X-Forwarded-For to bypass IP-based rate limiting.
 */
export function readTrustProxy(): boolean | number {
  const raw = process.env.TRUST_PROXY?.trim().toLowerCase();
  if (raw === undefined || raw === "") return 1;
  if (["false", "off", "no", "0"].includes(raw)) return false;
  if (["true", "on", "yes"].includes(raw)) return true;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 1 : n;
}

export function loadConfig(): Config {
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();

  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required. Set it as an environment variable.");
  }
  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required. Set it as an environment variable.");
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");

  return {
    apiToken,
    accountId,
    apiBaseUrl: (process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_API_BASE_URL).trim(),
    port: Number.parseInt(process.env.PORT || "3000", 10),
    host: (process.env.HOST || "0.0.0.0").trim(),
    publicBaseUrl: publicBaseUrl || undefined,
    trustProxy: readTrustProxy(),
    maxBodySize: (process.env.MAX_BODY_SIZE || "25mb").trim(),
    rateLimitWindowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
    rateLimitMax: Number.parseInt(process.env.RATE_LIMIT_MAX || "60", 10),
    allowedOrigins: (() => {
      const list = parseList(process.env.ALLOWED_ORIGINS);
      return list.length > 0 ? list : undefined;
    })(),
    uploadAllowedOrigins: (() => {
      const list = parseList(process.env.UPLOAD_ALLOWED_ORIGINS);
      return list.length > 0 ? list : undefined;
    })(),
    authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined,
    // Reuse the OAuth signing secret when present so upload URLs survive
    // restarts in production; otherwise fall back to a per-process secret
    // (upload URLs are short-lived, so an ephemeral secret is acceptable).
    uploadSigningSecret:
      process.env.UPLOAD_SIGNING_SECRET?.trim() ||
      process.env.OAUTH_SIGNING_SECRET?.trim() ||
      randomBytes(32).toString("hex"),
    oauth: readOAuthConfig(),
  };
}
