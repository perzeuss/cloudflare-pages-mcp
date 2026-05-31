import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contentTypeFor } from "../src/mime.js";

describe("contentTypeFor", () => {
  it("maps common web extensions", () => {
    assert.equal(contentTypeFor("index.html"), "text/html");
    assert.equal(contentTypeFor("app.css"), "text/css");
    assert.equal(contentTypeFor("app.js"), "text/javascript");
    assert.equal(contentTypeFor("data.json"), "application/json");
    assert.equal(contentTypeFor("logo.svg"), "image/svg+xml");
    assert.equal(contentTypeFor("photo.png"), "image/png");
  });

  it("is case-insensitive on the extension", () => {
    assert.equal(contentTypeFor("INDEX.HTML"), "text/html");
    assert.equal(contentTypeFor("Photo.PNG"), "image/png");
  });

  it("resolves the extension from a nested path", () => {
    assert.equal(contentTypeFor("/assets/fonts/body.woff2"), "font/woff2");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    assert.equal(contentTypeFor("archive.xyz"), "application/octet-stream");
    assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
  });
});
