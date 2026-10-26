import type { CloudflareClient, PagesProject } from "./cloudflare.js";

interface AccessApplication {
  id: string;
  name?: string;
  type?: string;
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: { type?: string; uri?: string; overrides?: unknown[] }[];
  policies?: (string | { id?: string })[];
  options_preflight_bypass?: boolean;
}

function destinations(app: AccessApplication): string[] {
  if (app.destinations?.length) {
    // A non-public destination cannot be verified by this hostname-based integration.
    return app.destinations.map((d) => d.uri ?? "");
  }
  return app.self_hosted_domains?.length ? app.self_hosted_domains : app.domain ? [app.domain] : [];
}

function overlaps(a: string, b: string): boolean {
  const hostA = a.toLowerCase().split("/")[0]!;
  const hostB = b.toLowerCase().split("/")[0]!;
  const matches = (pattern: string, host: string) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    ).test(host);
  return matches(hostA, hostB) || matches(hostB, hostA);
}

async function verify(
  client: CloudflareClient,
  app: AccessApplication,
  hostname: string,
  policyId: string,
): Promise<void> {
  const hosts = destinations(app);
  const policies = app.policies?.map((p) => (typeof p === "string" ? p : p.id));
  if (
    app.type !== "self_hosted" ||
    hosts.length !== 1 ||
    hosts[0] !== hostname ||
    !policies?.includes(policyId) ||
    new Set(policies).size !== policies?.length ||
    app.options_preflight_bypass ||
    app.destinations?.some(
      (d) => (d.type !== undefined && d.type !== "public") || d.overrides?.length,
    )
  ) {
    throw new Error(
      `Access configuration for ${hostname} does not exclusively enforce the selected policy. Configure it in Cloudflare before retrying.`,
    );
  }
  // Additional machine-access rules are operator-owned. Accept only reusable
  // Service Auth policies; never add, update or remove them here.
  for (const id of policies ?? []) {
    if (id === policyId) continue;
    if (!id) throw new Error(`Invalid additional Access policy for ${hostname}.`);
    const extra = await client.accessRequest<{ id: string; decision: string; reusable?: boolean }>(
      `/policies/${encodeURIComponent(id)}`,
    );
    if (extra.id !== id || extra.decision !== "non_identity" || extra.reusable !== true) {
      throw new Error(
        `Access configuration for ${hostname} does not exclusively allow the selected policy and reusable Service Auth policies.`,
      );
    }
  }
}

/** Establish full-host protection before uploading any site assets. Never edits operator rules. */
export async function ensureProjectAccess(
  client: CloudflareClient,
  project: PagesProject,
  policyId: string,
): Promise<string[]> {
  const policy = await client.accessRequest<{ id: string; decision: string; reusable?: boolean }>(
    `/policies/${encodeURIComponent(policyId)}`,
  );
  if (policy.id !== policyId || policy.decision !== "allow" || policy.reusable !== true) {
    throw new Error("The selected Access policy must be a reusable Allow policy in this account.");
  }

  const primary = project.subdomain || `${project.name}.pages.dev`;
  const hosts = [...new Set([primary, `*.${primary}`, ...(project.domains ?? [])])];
  if (hosts.some((host) => !/^(\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host))) {
    throw new Error("Cannot verify Access protection for an invalid Pages hostname.");
  }

  const apps: AccessApplication[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.accessRequest<AccessApplication[]>(
      `/apps?per_page=100&page=${page}`,
    );
    apps.push(...batch);
    if (batch.length < 100) break;
    if (page >= 1000) throw new Error("Access application listing exceeded the safety limit.");
  }

  // Reject overlapping apps (including more-specific path rules) rather than silently
  // replacing existing operator settings or overlooking a bypass application.
  for (const hostname of hosts) {
    const relevant = apps.filter((app) => destinations(app).some((d) => overlaps(d, hostname)));
    const exact = relevant.filter((app) => destinations(app).includes(hostname));
    if (relevant.some((app) => !exact.includes(app)) || exact.length > 1) {
      throw new Error(
        `Overlapping Access applications affect ${hostname}. Resolve them in Cloudflare before deploying.`,
      );
    }
    if (exact.length === 1) {
      const detail = await client.accessRequest<AccessApplication>(
        `/apps/${encodeURIComponent(exact[0]!.id)}`,
      );
      await verify(client, detail, hostname, policyId);
      continue;
    }
    const created = await client.accessRequest<AccessApplication>("/apps", {
      method: "POST",
      body: JSON.stringify({
        name: `Pages MCP: ${hostname}`,
        type: "self_hosted",
        domain: hostname,
        session_duration: "8h",
        policies: [{ id: policyId, precedence: 1 }],
      }),
    });
    if (!created.id)
      throw new Error(`Cloudflare did not return an Access application ID for ${hostname}.`);
    const detail = await client.accessRequest<AccessApplication>(
      `/apps/${encodeURIComponent(created.id)}`,
    );
    await verify(client, detail, hostname, policyId);
  }
  return hosts;
}
