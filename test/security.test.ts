/**
 * Unit tests for the constant-time comparison helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { safeStrEqual, verifyPassword } from "../src/security.ts";

test("safeStrEqual matches equal strings and rejects different ones", () => {
  assert.equal(safeStrEqual("secret-token", "secret-token"), true);
  assert.equal(safeStrEqual("secret-token", "secret-toket"), false);
  // Different lengths must not throw and must compare unequal.
  assert.equal(safeStrEqual("short", "a-much-longer-value"), false);
});

test("verifyPassword accepts the correct password and rejects wrong ones", () => {
  assert.equal(verifyPassword("hunter2", "hunter2"), true);
  assert.equal(verifyPassword("hunter2", "hunter3"), false);
  assert.equal(verifyPassword("", "hunter2"), false);
  // Length is not leaked: a wrong password of a different length still fails.
  assert.equal(verifyPassword("x", "hunter2-long-password"), false);
});
