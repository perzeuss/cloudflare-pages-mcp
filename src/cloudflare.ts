import { loadConfig } from "./config.js";
import { hashContent } from "./hash.js";
import { contentTypeFor } from "./mime.js";
import type { DeployFile } from "./files.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Upload batching limits (mirrors Wrangler's conservative bucketing). */
const MAX_BUCKET_FILES = 50;
const MAX_BUCKET_BYTES = 40 * 1024 * 1024; // base64 payload budget per request
const UPLOAD_RETRIES = 3;

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  messages?: { code: number; message: string }[];
}

export interface PagesProject {
  name: string;
  subdomain: string;
  domains: string[];
  production_branch?: string;
  created_on?: string;
}

export interface Deployment {
  id: string;
  url: string;
  environment?: string;
  project_name?: string;
}

interface AssetPayload {
  key: string;
  value: string; // base64
  metadata: { contentType: string };
  base64: true;
}

export class CloudflareError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CloudflareClient {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
  ) {}

  /** Reads credentials from the environment, throwing a clear error if absent. */
  static fromEnv(): CloudflareClient {
    try {
      const config = loadConfig();
      return new CloudflareClient(config.accountId, config.apiToken);
    } catch (err) {
      throw new CloudflareError(err instanceof Error ? err.message : String(err));
    }
  }

  private async json<T>(path: string, init: RequestInit = {}, token = this.apiToken): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    let body: CfResponse<T> | undefined;
    try {
      body = text ? (JSON.parse(text) as CfResponse<T>) : undefined;
    } catch {
      // fall through to raw-text error below
    }
    if (!res.ok || !body?.success) {
      const detail = body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || text;
      throw new CloudflareError(`Cloudflare API ${res.status} on ${path} — ${detail}`);
    }
    return body.result;
  }

  private accountPath(suffix = ""): string {
    return `/accounts/${this.accountId}/pages/projects${suffix}`;
  }

  async listProjects(): Promise<PagesProject[]> {
    return this.json<PagesProject[]>(this.accountPath());
  }

  async getProject(name: string): Promise<PagesProject> {
    return this.json<PagesProject>(this.accountPath(`/${encodeURIComponent(name)}`));
  }

  async projectExists(name: string): Promise<boolean> {
    try {
      await this.getProject(name);
      return true;
    } catch (err) {
      if (err instanceof CloudflareError && /\b404\b/.test(err.message)) return false;
      throw err;
    }
  }

  async createProject(name: string, productionBranch: string): Promise<PagesProject> {
    return this.json<PagesProject>(this.accountPath(), {
      method: "POST",
      body: JSON.stringify({ name, production_branch: productionBranch }),
    });
  }

  async deleteProject(name: string): Promise<void> {
    await this.json<unknown>(this.accountPath(`/${encodeURIComponent(name)}`), {
      method: "DELETE",
    });
  }

  /** Short-lived JWT used to authenticate the asset upload endpoints. */
  private async getUploadToken(projectName: string): Promise<string> {
    const result = await this.json<{ jwt: string }>(
      this.accountPath(`/${encodeURIComponent(projectName)}/upload-token`),
    );
    return result.jwt;
  }

  private async checkMissing(jwt: string, hashes: string[]): Promise<string[]> {
    return this.json<string[]>(
      "/pages/assets/check-missing",
      { method: "POST", body: JSON.stringify({ hashes }) },
      jwt,
    );
  }

  private async uploadBucket(jwt: string, bucket: AssetPayload[]): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
      try {
        await this.json<unknown>(
          "/pages/assets/upload",
          { method: "POST", body: JSON.stringify(bucket) },
          jwt,
        );
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < UPLOAD_RETRIES) await sleep(2 ** attempt * 500);
      }
    }
    throw lastErr;
  }

  private async upsertHashes(jwt: string, hashes: string[]): Promise<void> {
    await this.json<unknown>(
      "/pages/assets/upsert-hashes",
      { method: "POST", body: JSON.stringify({ hashes }) },
      jwt,
    );
  }

  private async createDeployment(
    projectName: string,
    manifest: Record<string, string>,
    branch?: string,
  ): Promise<Deployment> {
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    if (branch) form.set("branch", branch);
    return this.json<Deployment>(
      this.accountPath(`/${encodeURIComponent(projectName)}/deployments`),
      { method: "POST", body: form },
    );
  }

  /**
   * Runs the full Direct Upload flow: hash files, upload only the missing
   * ones, then create the deployment from the manifest.
   */
  async deploy(opts: {
    projectName: string;
    files: DeployFile[];
    branch?: string;
  }): Promise<{ deployment: Deployment; uploaded: number; total: number }> {
    // Map each unique hash to its base64 payload; build the path→hash manifest.
    const manifest: Record<string, string> = {};
    const payloads = new Map<string, AssetPayload>();
    for (const file of opts.files) {
      const hash = hashContent(file.contents, file.path);
      manifest[file.path] = hash;
      if (!payloads.has(hash)) {
        payloads.set(hash, {
          key: hash,
          value: file.contents.toString("base64"),
          metadata: { contentType: contentTypeFor(file.path) },
          base64: true,
        });
      }
    }

    const allHashes = [...payloads.keys()];
    const jwt = await this.getUploadToken(opts.projectName);
    const missing = new Set(await this.checkMissing(jwt, allHashes));

    const toUpload = allHashes.filter((h) => missing.has(h)).map((h) => payloads.get(h)!);
    for (const bucket of bucketize(toUpload)) {
      await this.uploadBucket(jwt, bucket);
    }

    await this.upsertHashes(jwt, allHashes);
    const deployment = await this.createDeployment(opts.projectName, manifest, opts.branch);

    return { deployment, uploaded: toUpload.length, total: allHashes.length };
  }
}

/** Splits asset payloads into request-sized buckets (by count and byte budget). */
function bucketize(payloads: AssetPayload[]): AssetPayload[][] {
  const buckets: AssetPayload[][] = [];
  let current: AssetPayload[] = [];
  let bytes = 0;
  for (const payload of payloads) {
    const size = payload.value.length;
    if (
      current.length >= MAX_BUCKET_FILES ||
      (current.length > 0 && bytes + size > MAX_BUCKET_BYTES)
    ) {
      buckets.push(current);
      current = [];
      bytes = 0;
    }
    current.push(payload);
    bytes += size;
  }
  if (current.length > 0) buckets.push(current);
  return buckets;
}
