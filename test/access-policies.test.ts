import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAccessPolicies, resolveAccessPolicy } from "../src/access-policies.js";

const id = "f174e90a-fafe-4643-bbbc-4a0ed4fc8415";
const other = "597147a1-976b-4ef2-9af0-81d5d007fc34";

test("policy catalogs support JSON/YAML files and ENV overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-policy-test-"));
  try {
    for (const [extension, content] of [
      ["json", JSON.stringify({ private_pages: id })],
      ["yaml", `private_pages: ${id}\n`],
    ]) {
      const file = join(dir, `policies.${extension}`);
      writeFileSync(file, content!);
      assert.equal(
        readAccessPolicies({ ACCESS_POLICIES_FILE: file }).accessPolicies?.private_pages,
        id,
      );
      const config = readAccessPolicies({
        ACCESS_POLICIES_FILE: file,
        ACCESS_POLICIES: JSON.stringify({ private_pages: other }),
        DEFAULT_ACCESS_POLICY_ID: id,
      });
      assert.equal(resolveAccessPolicy(config, "private_pages"), other);
      assert.equal(resolveAccessPolicy(config), id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy catalogs fail closed on invalid configuration and unknown names", () => {
  for (const value of [
    '{"private_pages":"invalid"}',
    "[]",
    "null",
    "{broken",
    '{"__proto__":"' + id + '"}',
  ]) {
    assert.throws(() => readAccessPolicies({ ACCESS_POLICIES: value }));
  }
  assert.throws(() => readAccessPolicies({ DEFAULT_ACCESS_POLICY_ID: "invalid" }));
  assert.throws(() => readAccessPolicies({ ACCESS_POLICIES_FILE: "/missing/policies.yaml" }));
  assert.throws(() => resolveAccessPolicy({ defaultAccessPolicyId: id }, "missing"), /Unknown/);
  assert.throws(() => resolveAccessPolicy({}, "toString"), /Unknown/);
  assert.equal(resolveAccessPolicy({}), undefined);
});

test("duplicate YAML names, aliases and oversized files are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-policy-test-"));
  const file = join(dir, "policies.yaml");
  try {
    for (const text of [
      `private_pages: ${id}\nprivate_pages: ${other}`,
      `private_pages: &id ${id}\nother: *id`,
      " ".repeat(1024 * 1024 + 1),
    ]) {
      writeFileSync(file, text);
      assert.throws(() => readAccessPolicies({ ACCESS_POLICIES_FILE: file }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login methods are optional and unrestricted when unset", () => {
  for (const env of [{}, { ACCESS_LOGIN_METHODS: "" }, { ACCESS_LOGIN_METHODS: "  " }]) {
    const config = readAccessPolicies(env);
    assert.equal(config.accessLoginMethods, undefined);
    assert.equal(config.accessIdpIds, undefined);
  }
});

test("login methods accept google and otp, ignore case, separators and duplicates", () => {
  assert.deepEqual(readAccessPolicies({ ACCESS_LOGIN_METHODS: "google,otp" }).accessLoginMethods, [
    "google",
    "otp",
  ]);
  assert.deepEqual(
    readAccessPolicies({ ACCESS_LOGIN_METHODS: " OTP  Google, otp " }).accessLoginMethods,
    ["otp", "google"],
  );
  assert.deepEqual(readAccessPolicies({ ACCESS_LOGIN_METHODS: "otp" }).accessLoginMethods, ["otp"]);
});

test("unknown login methods fail closed without echoing the value", () => {
  for (const value of ["github", "google,password", "totp"]) {
    assert.throws(
      () => readAccessPolicies({ ACCESS_LOGIN_METHODS: value }),
      (error: Error) =>
        /Unsupported ACCESS_LOGIN_METHODS/.test(error.message) && !error.message.includes(value),
    );
  }
});

test("identity provider IDs need their method and must be UUIDs", () => {
  const config = readAccessPolicies({
    ACCESS_LOGIN_METHODS: "google,otp",
    ACCESS_GOOGLE_IDP_ID: id,
    ACCESS_OTP_IDP_ID: other,
  });
  assert.deepEqual(config.accessIdpIds, { google: id, otp: other });
  assert.throws(
    () => readAccessPolicies({ ACCESS_LOGIN_METHODS: "otp", ACCESS_GOOGLE_IDP_ID: id }),
    /not listed in ACCESS_LOGIN_METHODS/,
  );
  assert.throws(
    () => readAccessPolicies({ ACCESS_GOOGLE_IDP_ID: id }),
    /not listed in ACCESS_LOGIN_METHODS/,
  );
  assert.throws(() =>
    readAccessPolicies({ ACCESS_LOGIN_METHODS: "google", ACCESS_GOOGLE_IDP_ID: "invalid" }),
  );
});
