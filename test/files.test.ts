import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectFiles, normalizePath, MAX_FILE_SIZE } from "../src/files.js";

describe("normalizePath", () => {
  it("adds a leading slash", () => {
    assert.equal(normalizePath("index.html"), "/index.html");
  });

  it("strips a leading ./", () => {
    assert.equal(normalizePath("./assets/app.css"), "/assets/app.css");
  });

  it("converts backslashes to forward slashes", () => {
    assert.equal(normalizePath("assets\\img\\logo.png"), "/assets/img/logo.png");
  });

  it("collapses duplicate slashes", () => {
    assert.equal(normalizePath("assets//img///logo.png"), "/assets/img/logo.png");
  });

  it("strips leading slashes before re-adding exactly one", () => {
    assert.equal(normalizePath("///index.html"), "/index.html");
  });
});

describe("collectFiles", () => {
  it("throws when no files are provided", async () => {
    await assert.rejects(() => collectFiles({}), /No files to deploy/);
  });

  it("throws when the files array is empty", async () => {
    await assert.rejects(() => collectFiles({ files: [] }), /No files to deploy/);
  });

  it("collects inline files with normalized paths", async () => {
    const result = await collectFiles({
      files: [{ path: "index.html", content: "<h1>hi</h1>" }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.path, "/index.html");
    assert.equal(result[0]!.contents.toString("utf8"), "<h1>hi</h1>");
  });

  it("decodes base64 inline content", async () => {
    const result = await collectFiles({
      files: [
        {
          path: "a.bin",
          content: Buffer.from("binary").toString("base64"),
          encoding: "base64",
        },
      ],
    });
    assert.equal(result[0]!.contents.toString("utf8"), "binary");
  });

  it("collects multiple inline files with normalized paths", async () => {
    const result = await collectFiles({
      files: [
        { path: "index.html", content: "root" },
        { path: "./assets/app.css", content: "css" },
      ],
    });
    const paths = result.map((f) => f.path).sort();
    assert.deepEqual(paths, ["/assets/app.css", "/index.html"]);
  });

  it("lets a later inline file win over an earlier one on path conflicts", async () => {
    const result = await collectFiles({
      files: [
        { path: "index.html", content: "first" },
        { path: "index.html", content: "second" },
      ],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.contents.toString("utf8"), "second");
  });

  it("rejects files exceeding the per-file size limit", async () => {
    const big = "x".repeat(MAX_FILE_SIZE + 1);
    await assert.rejects(
      () => collectFiles({ files: [{ path: "big.txt", content: big }] }),
      /exceeding the 25 MiB per-file limit/,
    );
  });
});
