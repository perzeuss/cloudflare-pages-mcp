/**
 * Stateless OAuth 2.1 authorization-server provider for the MCP endpoint.
 *
 * This is what makes the server usable as a Claude custom connector: Claude
 * performs OAuth discovery + dynamic client registration, sends the user
 * through a consent screen, and then calls the MCP endpoint with a Bearer
 * access token.
 *
 * Design:
 *  - No database. Authorization codes, access/refresh tokens and even client
 *    registrations are HMAC-signed, self-describing tokens (see security.ts).
 *  - User authentication is a single shared password (OAUTH_PASSWORD) entered
 *    on a minimal consent screen.
 *  - PKCE (S256) is enforced by the SDK's token handler.
 */

import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import type { OAuthConfig } from "./config.js";
import { escapeHtml, safeStrEqual, signToken, verifyToken } from "./security.js";

type Claims = Record<string, unknown>;

/** Render the minimal consent / sign-in screen. */
function renderConsent(
  actionUrl: string,
  fields: Record<string, string | undefined>,
  error?: string,
): string {
  const hidden = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(
      ([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`,
    )
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Cloudflare Pages MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; background:#0f1115; color:#e6e6e6;
           display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    .card { background:#191c24; padding:2rem; border-radius:12px; width:320px;
            box-shadow:0 10px 40px rgba(0,0,0,.4); }
    h1 { font-size:1.1rem; margin:0 0 1rem; }
    p { color:#9aa0aa; font-size:.85rem; margin:0 0 1.2rem; }
    input[type=password] { width:100%; padding:.6rem; border-radius:8px; border:1px solid #2a2f3a;
            background:#0f1115; color:#fff; box-sizing:border-box; }
    button { width:100%; margin-top:1rem; padding:.6rem; border:0; border-radius:8px;
            background:#f6821f; color:#fff; font-weight:600; cursor:pointer; }
    .err { color:#ff6b6b; font-size:.8rem; margin-top:.6rem; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="${escapeHtml(actionUrl)}">
    <h1>Cloudflare Pages MCP</h1>
    <p>Authorize this connector by entering the access password.</p>
    ${hidden}
    <input type="password" name="password" placeholder="Password" autofocus required>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

export class StatelessOAuthProvider implements OAuthServerProvider {
  constructor(private readonly cfg: OAuthConfig) {}

  // --- Dynamic client registration (stateless: client info lives in the id) ---
  get clientsStore(): OAuthRegisteredClientsStore {
    const secret = this.cfg.signingSecret;
    return {
      getClient: (clientId: string) => {
        const claims = verifyToken(clientId, secret);
        if (!claims || claims.t !== "client") return undefined;
        // Reattach the (self-describing) id to the decoded metadata.
        return {
          ...(claims.c as object),
          client_id: clientId,
        } as OAuthClientInformationFull;
      },
      registerClient: (client) => {
        // Encode the client metadata into a signed, self-describing client_id
        // so no server-side storage is needed and it survives restarts.
        const meta = {
          ...client,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        const clientId = signToken({ t: "client", c: meta }, secret);
        return { ...meta, client_id: clientId } as OAuthClientInformationFull;
      },
    };
  }

  // --- Authorization endpoint: consent screen + code issuance ---------------
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const req = res.req;
    const submittedPassword =
      typeof req?.body?.password === "string" ? req.body.password : undefined;

    const actionUrl = new URL("/authorize", this.cfg.issuerUrl).href;
    const formFields: Record<string, string | undefined> = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      response_type: "code",
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      scope: params.scopes?.join(" "),
      state: params.state,
      resource: params.resource?.href,
    };

    if (submittedPassword === undefined) {
      // First visit (GET) — show the consent screen.
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderConsent(actionUrl, formFields));
      return;
    }

    if (!safeStrEqual(submittedPassword, this.cfg.password)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderConsent(actionUrl, formFields, "Incorrect password."));
      return;
    }

    // Authenticated — issue a short-lived authorization code bound to the
    // client, PKCE challenge and redirect URI.
    const code = signToken(
      {
        t: "code",
        cid: client.client_id,
        cc: params.codeChallenge,
        ru: params.redirectUri,
        sc: params.scopes ?? [],
        res: params.resource?.href,
      },
      this.cfg.signingSecret,
      300,
    );

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  }

  // --- PKCE challenge lookup (called by the SDK token handler) --------------
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const claims = this.decodeCode(client, authorizationCode);
    return claims.cc as string;
  }

  // --- Authorization code -> tokens -----------------------------------------
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const claims = this.decodeCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== claims.ru) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    const scopes = (claims.sc as string[]) ?? [];
    return this.issueTokens(client.client_id, scopes);
  }

  // --- Refresh token -> new access token ------------------------------------
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const claims = verifyToken(refreshToken, this.cfg.signingSecret);
    if (!claims || claims.t !== "refresh" || claims.cid !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const grantedScopes = (claims.sc as string[]) ?? [];
    // A refresh request may only narrow scopes, never widen them.
    const effective =
      scopes && scopes.length > 0 ? scopes.filter((s) => grantedScopes.includes(s)) : grantedScopes;
    return this.issueTokens(client.client_id, effective);
  }

  // --- Access-token verification (called by requireBearerAuth) --------------
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = verifyToken(token, this.cfg.signingSecret);
    if (!claims || claims.t !== "access") {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: claims.cid as string,
      scopes: (claims.sc as string[]) ?? [],
      expiresAt: claims.exp as number | undefined,
    };
  }

  private decodeCode(client: OAuthClientInformationFull, code: string): Claims {
    const claims = verifyToken(code, this.cfg.signingSecret);
    if (!claims || claims.t !== "code") {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (claims.cid !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to another client");
    }
    return claims;
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const access_token = signToken(
      { t: "access", cid: clientId, sc: scopes },
      this.cfg.signingSecret,
      this.cfg.accessTokenTtl,
    );
    const refresh_token = signToken(
      { t: "refresh", cid: clientId, sc: scopes },
      this.cfg.signingSecret,
      this.cfg.refreshTokenTtl,
    );
    return {
      access_token,
      token_type: "bearer",
      expires_in: this.cfg.accessTokenTtl,
      scope: scopes.join(" ") || undefined,
      refresh_token,
    };
  }
}

// Re-export so index.ts doesn't need a deep import path.
export { ServerError };
