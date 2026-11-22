import { loadConfig } from "./config.js";
import { hashContent } from "./hash.js";
import { contentTypeFor } from "./mime.js";
import { MAX_FILE_SIZE, type DeployFile } from "./files.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Upload batching limits (mirrors Wrangler's conservative bucketing). */
const MAX_BUCKET_FILES = 50;
const MAX_BUCKET_BYTES = 40 * 1024 * 1024; // base64 payload budget per request
const UPLOAD_RETRIES = 3;

/**
 * Root files that configure the Pages project instead of being served. The
 * Direct Upload API takes them as separate form fields of the deployment (as
 * Wrangler sends them); uploaded as assets they are served as plain files and
 * have no effect.
 */
const CONFIG_FILES = new Set(["/_headers", "/_redirects", "/_routes.json"]);
const WORKER_PATH = "/_worker.js";
export const aiBindingNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

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
  deployment_configs?: Partial<
    Record<"production" | "preview", { ai_bindings?: Record<string, unknown> }>
  >;
}

export interface PagesDomain {
  name: string;
  status?: string;
  validation_data?: { status?: string; error_message?: string };
  verification_data?: { status?: string; error_message?: string };
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export interface Zone {
  id: string;
  name: string;
  account?: { id?: string };
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
    private readonly apiBaseUrl = API_BASE,
  ) {}

  /** Reads credentials from the environment, throwing a clear error if absent. */
  static fromEnv(): CloudflareClient {
    try {
      const config = loadConfig();
      return new CloudflareClient(config.accountId, config.apiToken, config.apiBaseUrl);
    } catch (err) {
      throw new CloudflareError(err instanceof Error ? err.message : String(err));
    }
  }

  private async json<T>(path: string, init: RequestInit = {}, token = this.apiToken): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
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

  /** Account-scoped Access API; credentials stay on the server. */
  async accessRequest<T>(suffix: string, init: RequestInit = {}): Promise<T> {
    return this.json<T>(`/accounts/${this.accountId}/access${suffix}`, init);
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

  async setProjectBindings(
    name: string,
    aiBindings: string[],
    includePreview = false,
  ): Promise<PagesProject> {
    if (!aiBindings.length || aiBindings.some((binding) => !aiBindingNamePattern.test(binding))) {
      throw new CloudflareError(
        "Provide at least one AI binding name matching ^[A-Z][A-Z0-9_]{0,63}$.",
      );
    }
    const production = { ai_bindings: Object.fromEntries(aiBindings.map((name) => [name, {}])) };
    return this.json<PagesProject>(this.accountPath(`/${encodeURIComponent(name)}`), {
      method: "PATCH",
      body: JSON.stringify({
        deployment_configs: { production, ...(includePreview && { preview: production }) },
      }),
    });
  }

  /** Attach a custom domain to a Pages project. */
  async addProjectDomain(project: string, domain: string): Promise<PagesDomain> {
    return this.json<PagesDomain>(this.accountPath(`/${encodeURIComponent(project)}/domains`), {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    });
  }

  async deleteProjectDomain(project: string, domain: string): Promise<void> {
    await this.json<unknown>(
      this.accountPath(`/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`),
      { method: "DELETE" },
    );
  }

  async getProjectDomain(project: string, domain: string): Promise<PagesDomain> {
    return this.json<PagesDomain>(
      this.accountPath(`/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`),
    );
  }

  /** The zone in this account that holds `hostname`, matched by its longest suffix. */
  async findZone(hostname: string): Promise<Zone | undefined> {
    const labels = hostname.toLowerCase().split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const zones = await this.json<Zone[]>(
        `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(this.accountId)}`,
      );
      const zone = zones.find((z) => z.name === name && z.account?.id === this.accountId);
      if (zone) return zone;
    }
    return undefined;
  }

  async listDnsRecords(zoneId: string, name: string): Promise<DnsRecord[]> {
    return this.json<DnsRecord[]>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}`,
    );
  }

  async createDnsRecord(
    zoneId: string,
    record: { type: "CNAME"; name: string; content: string; proxied: boolean },
  ): Promise<DnsRecord> {
    return this.json<DnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ ...record, ttl: 1 }),
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
    config: DeployFile[] = [],
    worker?: DeployFile,
  ): Promise<Deployment> {
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    if (branch) form.set("branch", branch);
    for (const file of config) {
      const name = file.path.slice(1);
      form.set(name, new File([new Uint8Array(file.contents)], name));
    }
    if (worker) {
      // Wrangler serializes the module form into the deployment's _worker.bundle file:
      // https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/api/pages/deploy.ts#L359-L368
      // https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/api/pages/create-worker-bundle-contents.ts#L16-L28
      const name = WORKER_PATH.slice(1);
      const bundle = new FormData();
      bundle.set("metadata", JSON.stringify({ main_module: name }));
      bundle.set(
        name,
        new File([new Uint8Array(worker.contents)], name, {
          type: "application/javascript+module",
        }),
      );
      form.set("_worker.bundle", new File([await new Response(bundle).blob()], "_worker.bundle"));
    }
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
    const config: DeployFile[] = [];
    let worker: DeployFile | undefined;
    for (const file of opts.files) {
      if (file.path === WORKER_PATH) {
        if (file.contents.byteLength > MAX_FILE_SIZE) {
          throw new CloudflareError(`Worker ${WORKER_PATH} exceeds the 25 MiB per-file limit.`);
        }
        worker = file;
        continue;
      }
      if (file.path.startsWith(WORKER_PATH + "/")) {
        throw new CloudflareError(
          "Bundle the _worker.js directory into a single /_worker.js ES module.",
        );
      }
      if (CONFIG_FILES.has(file.path)) {
        config.push(file);
        continue;
      }
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
    let uploaded = 0;
    if (allHashes.length) {
      const jwt = await this.getUploadToken(opts.projectName);
      const missing = new Set(await this.checkMissing(jwt, allHashes));
      const toUpload = allHashes.filter((h) => missing.has(h)).map((h) => payloads.get(h)!);
      for (const bucket of bucketize(toUpload)) {
        await this.uploadBucket(jwt, bucket);
      }
      await this.upsertHashes(jwt, allHashes);
      uploaded = toUpload.length;
    }
    const deployment = await this.createDeployment(
      opts.projectName,
      manifest,
      opts.branch,
      config,
      worker,
    );
    return { deployment, uploaded, total: allHashes.length };
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
