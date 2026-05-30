import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

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
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cfpages-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws when no files and no directory are provided", async () => {
    await assert.rejects(() => collectFiles({}), /No files to deploy/);
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

  it("walks a directory recursively and skips ignored names", async () => {
    await writeFile(path.join(dir, "index.html"), "root");
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "assets", "app.css"), "css");
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "node_modules", "ignored.js"), "nope");

    const result = await collectFiles({ directory: dir });
    const paths = result.map((f) => f.path).sort();
    assert.deepEqual(paths, ["/assets/app.css", "/index.html"]);
  });

  it("lets inline files win over directory files on path conflicts", async () => {
    await writeFile(path.join(dir, "index.html"), "from-dir");
    const result = await collectFiles({
      directory: dir,
      files: [{ path: "index.html", content: "from-inline" }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.contents.toString("utf8"), "from-inline");
  });

  it("rejects files exceeding the per-file size limit", async () => {
    const big = "x".repeat(MAX_FILE_SIZE + 1);
    await assert.rejects(
      () => collectFiles({ files: [{ path: "big.txt", content: big }] }),
      /exceeding the 25 MiB per-file limit/,
    );
  });
});
