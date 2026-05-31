/**
 * Tests for configuration loading.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, readOAuthConfig, readTrustProxy } from "../src/config.ts";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const creds = {
  CLOUDFLARE_API_TOKEN: "tok",
  CLOUDFLARE_ACCOUNT_ID: "acct",
};

test("loadConfig throws when CLOUDFLARE_API_TOKEN is missing", () => {
  withEnv({ CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: "acct" }, () => {
    assert.throws(() => loadConfig(), /CLOUDFLARE_API_TOKEN/);
  });
});

test("loadConfig throws when CLOUDFLARE_ACCOUNT_ID is missing", () => {
  withEnv({ CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: undefined }, () => {
    assert.throws(() => loadConfig(), /CLOUDFLARE_ACCOUNT_ID/);
  });
});

test("loadConfig returns Cloudflare creds when both vars are set", () => {
  withEnv(creds, () => {
    const config = loadConfig();
    assert.equal(config.apiToken, "tok");
    assert.equal(config.accountId, "acct");
    assert.ok(config.apiBaseUrl.startsWith("https://"));
  });
});

test("loadConfig applies server defaults", () => {
  withEnv(
    {
      ...creds,
      PORT: undefined,
      HOST: undefined,
      RATE_LIMIT_MAX: undefined,
      MAX_BODY_SIZE: undefined,
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.port, 3000);
      assert.equal(cfg.host, "0.0.0.0");
      assert.equal(cfg.rateLimitMax, 60);
      assert.equal(cfg.maxBodySize, "25mb");
    },
  );
});

test("loadConfig detects OAuth when OAUTH_PASSWORD is set", () => {
  withEnv(
    {
      ...creds,
      OAUTH_PASSWORD: "pw",
      OAUTH_ISSUER_URL: "https://example.com",
      OAUTH_SIGNING_SECRET: "s",
    },
    () => {
      const cfg = loadConfig();
      assert.ok(cfg.oauth);
      assert.equal(cfg.oauth?.issuerUrl, "https://example.com");
    },
  );
});

test("readTrustProxy parses values", () => {
  withEnv({ TRUST_PROXY: "3" }, () => {
    assert.equal(readTrustProxy(), 3);
  });
  withEnv({ TRUST_PROXY: "false" }, () => {
    assert.equal(readTrustProxy(), false);
  });
  withEnv({ TRUST_PROXY: "true" }, () => {
    assert.equal(readTrustProxy(), true);
  });
  withEnv({ TRUST_PROXY: undefined }, () => {
    assert.equal(readTrustProxy(), 1);
  });
});

test("readOAuthConfig returns undefined without password", () => {
  withEnv({ OAUTH_PASSWORD: undefined }, () => {
    assert.equal(readOAuthConfig(), undefined);
  });
});

test("readOAuthConfig builds config when password + issuer set", () => {
  withEnv(
    {
      OAUTH_PASSWORD: "pw",
      OAUTH_ISSUER_URL: "https://example.com",
      OAUTH_SIGNING_SECRET: "s",
    },
    () => {
      const cfg = readOAuthConfig();
      assert.ok(cfg);
      assert.equal(cfg?.issuerUrl, "https://example.com");
      assert.equal(cfg?.accessTokenTtl, 3600);
      assert.equal(cfg?.refreshTokenTtl, 2592000);
    },
  );
});

test("readOAuthConfig throws when issuer URL is missing", () => {
  withEnv(
    {
      OAUTH_PASSWORD: "pw",
      OAUTH_ISSUER_URL: undefined,
      PUBLIC_BASE_URL: undefined,
    },
    () => {
      assert.throws(() => readOAuthConfig(), /issuer URL/);
    },
  );
});
