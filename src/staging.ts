/**
 * In-memory staging store for incremental (chunked) deployments.
 *
 * A remote connector receives every file as a tool argument, so a single
 * `deploy` call is bounded by the model's output-token limit. For large sites
 * the caller instead opens a staging deployment, appends files across several
 * small `add_files` calls, and finally publishes them as ONE Cloudflare
 * deployment.
 *
 * State lives in process memory with a TTL. This is correct for a single
 * server instance; running multiple replicas behind a load balancer would
 * require a shared store (e.g. R2/KV) so batches don't land on different
 * instances.
 */

import { randomUUID } from "node:crypto";
import type { DeployFile } from "./files.js";
import { MAX_FILES } from "./files.js";

export interface StagedDeployment {
  id: string;
  projectName: string;
  branch?: string;
  createIfMissing: boolean;
  productionBranch: string;
  /** Normalized site path -> file. Later adds overwrite earlier ones. */
  files: Map<string, DeployFile>;
  createdAt: number;
  expiresAt: number;
}

export interface StagingStoreOptions {
  /** How long a staged deployment lives without activity, in ms. */
  ttlMs?: number;
  /** Max number of concurrently staged deployments (abuse guard). */
  maxDeployments?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_DEPLOYMENTS = 50;

export class StagingStore {
  private readonly deployments = new Map<string, StagedDeployment>();
  private readonly ttlMs: number;
  private readonly maxDeployments: number;

  constructor(opts: StagingStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxDeployments = opts.maxDeployments ?? DEFAULT_MAX_DEPLOYMENTS;
  }

  /** Open a new staging deployment and return its id. */
  create(opts: {
    projectName: string;
    branch?: string;
    createIfMissing: boolean;
    productionBranch: string;
  }): StagedDeployment {
    this.sweep();
    if (this.deployments.size >= this.maxDeployments) {
      throw new Error(
        `Too many staged deployments in progress (max ${this.maxDeployments}). ` +
          "Publish or wait for existing ones to expire.",
      );
    }
    const now = Date.now();
    const staged: StagedDeployment = {
      id: randomUUID(),
      projectName: opts.projectName,
      branch: opts.branch,
      createIfMissing: opts.createIfMissing,
      productionBranch: opts.productionBranch,
      files: new Map(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.deployments.set(staged.id, staged);
    return staged;
  }

  /** Look up a live staged deployment, throwing if missing or expired. */
  get(id: string): StagedDeployment {
    this.sweep();
    const staged = this.deployments.get(id);
    if (!staged) {
      throw new Error(
        `Unknown or expired deploy_id "${id}". Staged deployments expire after ` +
          `${Math.round(this.ttlMs / 60000)} minutes of inactivity; start a new one with create_deployment.`,
      );
    }
    return staged;
  }

  /** Append files to a staged deployment, refreshing its TTL. */
  addFiles(id: string, files: DeployFile[]): StagedDeployment {
    const staged = this.get(id);
    for (const file of files) {
      staged.files.set(file.path, file);
    }
    if (staged.files.size > MAX_FILES) {
      // Roll back conceptually by rejecting; the caller staged too much.
      throw new Error(
        `Staged file count ${staged.files.size} exceeds the Cloudflare Pages limit of ${MAX_FILES}.`,
      );
    }
    staged.expiresAt = Date.now() + this.ttlMs;
    return staged;
  }

  /** Remove a staged deployment (after publish or on discard). */
  delete(id: string): void {
    this.deployments.delete(id);
  }

  /** Drop expired deployments. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, staged] of this.deployments) {
      if (staged.expiresAt <= now) this.deployments.delete(id);
    }
  }
}
