import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StagingStore } from "../src/staging.js";
import type { DeployFile } from "../src/files.js";

const file = (path: string, body: string): DeployFile => ({
  path,
  contents: Buffer.from(body),
});

describe("StagingStore", () => {
  it("creates a staged deployment with a unique id", () => {
    const store = new StagingStore();
    const a = store.create({ projectName: "p", createIfMissing: true, productionBranch: "main" });
    const b = store.create({ projectName: "p", createIfMissing: true, productionBranch: "main" });
    assert.notEqual(a.id, b.id);
    assert.equal(a.files.size, 0);
  });

  it("accumulates files across add_files calls", () => {
    const store = new StagingStore();
    const { id } = store.create({
      projectName: "p",
      createIfMissing: true,
      productionBranch: "main",
    });
    store.addFiles(id, [file("/index.html", "1")]);
    const staged = store.addFiles(id, [file("/a.css", "2")]);
    assert.equal(staged.files.size, 2);
  });

  it("overwrites a file when the same path is added again", () => {
    const store = new StagingStore();
    const { id } = store.create({
      projectName: "p",
      createIfMissing: true,
      productionBranch: "main",
    });
    store.addFiles(id, [file("/index.html", "first")]);
    const staged = store.addFiles(id, [file("/index.html", "second")]);
    assert.equal(staged.files.size, 1);
    assert.equal(staged.files.get("/index.html")!.contents.toString(), "second");
  });

  it("throws for an unknown deploy_id", () => {
    const store = new StagingStore();
    assert.throws(() => store.get("nope"), /Unknown or expired deploy_id/);
  });

  it("expires staged deployments after the TTL", () => {
    const store = new StagingStore({ ttlMs: -1 }); // already expired on next access
    const { id } = store.create({
      projectName: "p",
      createIfMissing: true,
      productionBranch: "main",
    });
    assert.throws(() => store.get(id), /Unknown or expired deploy_id/);
  });

  it("deletes a staged deployment after publish", () => {
    const store = new StagingStore();
    const { id } = store.create({
      projectName: "p",
      createIfMissing: true,
      productionBranch: "main",
    });
    store.delete(id);
    assert.throws(() => store.get(id), /Unknown or expired deploy_id/);
  });

  it("enforces a maximum number of concurrent staged deployments", () => {
    const store = new StagingStore({ maxDeployments: 1 });
    store.create({ projectName: "p", createIfMissing: true, productionBranch: "main" });
    assert.throws(
      () => store.create({ projectName: "q", createIfMissing: true, productionBranch: "main" }),
      /Too many staged deployments/,
    );
  });
});
