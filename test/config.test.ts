import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("throws when CLOUDFLARE_API_TOKEN is missing", () => {
    assert.throws(
      () => loadConfig({ CLOUDFLARE_ACCOUNT_ID: "acct" } as NodeJS.ProcessEnv),
      /CLOUDFLARE_API_TOKEN is required/,
    );
  });

  it("throws when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    assert.throws(
      () => loadConfig({ CLOUDFLARE_API_TOKEN: "token" } as NodeJS.ProcessEnv),
      /CLOUDFLARE_ACCOUNT_ID is required/,
    );
  });

  it("lists every missing variable when both are absent", () => {
    assert.throws(
      () => loadConfig({} as NodeJS.ProcessEnv),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /CLOUDFLARE_API_TOKEN is required/);
        assert.match(err.message, /CLOUDFLARE_ACCOUNT_ID is required/);
        return true;
      },
    );
  });

  it("returns a typed config when both variables are present", () => {
    const cfg = loadConfig({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.cloudflareApiToken, "token");
    assert.equal(cfg.cloudflareAccountId, "acct");
  });

  it("reads from process.env by default", () => {
    const saved = { ...process.env };
    try {
      process.env.CLOUDFLARE_API_TOKEN = "env-token";
      process.env.CLOUDFLARE_ACCOUNT_ID = "env-acct";
      const cfg = loadConfig();
      assert.equal(cfg.cloudflareApiToken, "env-token");
      assert.equal(cfg.cloudflareAccountId, "env-acct");
    } finally {
      process.env = saved;
    }
  });
});
