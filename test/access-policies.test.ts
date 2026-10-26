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
