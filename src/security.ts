/**
 * Small, dependency-free security helpers, kept pure so they can be unit
 * tested in isolation.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Create a compact, HMAC-signed token: `base64url(payload).base64url(sig)`.
 * Stateless — no server-side storage needed. `ttlSeconds` adds an `exp` claim.
 */
export function signToken(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds?: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...payload,
    iat: now,
    ...(ttlSeconds ? { exp: now + ttlSeconds } : {}),
  };
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify an HMAC-signed token and return its claims, or null if the signature
 * is invalid, the token is malformed, or it has expired.
 */
export function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return claims;
}

/** HTML-escape untrusted text for safe interpolation into markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Constant-time string comparison. Hashing both inputs first means we compare
 * equal-length buffers regardless of input length, so neither the result nor
 * the timing leaks the length or content of the secret.
 */
export function safeStrEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Parse a comma/whitespace separated environment list into trimmed entries. */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parse a boolean-ish environment value, falling back to `fallback`. */
export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Decide whether a request Origin is acceptable. An empty allow-list means
 * "no Origin restriction" (server-to-server clients such as Claude do not send
 * a browser Origin). A request without an Origin header is always allowed; the
 * check only rejects Origins that are present but not allow-listed.
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return true;
  return allowed.includes(origin);
}
