import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashContent } from "../src/hash.js";

describe("hashContent", () => {
  it("returns a 32-char lowercase hex string", () => {
    const hash = hashContent(Buffer.from("hello world"), "index.html");
    assert.match(hash, /^[0-9a-f]{32}$/);
  });

  it("is deterministic for identical content and extension", () => {
    const a = hashContent(Buffer.from("same"), "a.css");
    const b = hashContent(Buffer.from("same"), "b.css");
    assert.equal(a, b);
  });

  it("incorporates the file extension into the hash", () => {
    const asHtml = hashContent(Buffer.from("data"), "file.html");
    const asCss = hashContent(Buffer.from("data"), "file.css");
    assert.notEqual(asHtml, asCss);
  });

  it("changes when content changes", () => {
    const a = hashContent(Buffer.from("one"), "x.txt");
    const b = hashContent(Buffer.from("two"), "x.txt");
    assert.notEqual(a, b);
  });

  it("treats a missing extension as an empty extension", () => {
    const hash = hashContent(Buffer.from("data"), "LICENSE");
    assert.match(hash, /^[0-9a-f]{32}$/);
  });
});
