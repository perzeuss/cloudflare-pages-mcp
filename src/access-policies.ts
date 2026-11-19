import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const policyId = z.uuid();
const nameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const catalogSchema = z.record(nameSchema, policyId);
function readCatalog(value: unknown): Record<string, string> {
  // Validate keys before Zod constructs its output (which omits __proto__).
  if (value && typeof value === "object")
    Object.keys(value).forEach((key) => nameSchema.parse(key));
  return catalogSchema.parse(value);
}
/**
 * Login methods an operator can allow on protected Pages. Each maps to one
 * Cloudflare Access identity provider type (see access.ts), so adding a method
 * means adding an entry here and in IDP_TYPES.
 */
export const LOGIN_METHODS = ["google", "otp"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];
export type LoginMethodIdpIds = Partial<Record<LoginMethod, string>>;

export interface AccessPolicyConfig {
  accessPolicies?: Record<string, string>;
  defaultAccessPolicyId?: string;
  /**
   * Login methods the generated Access applications accept (ACCESS_LOGIN_METHODS).
   * Undefined means unrestricted: Cloudflare then offers every identity provider
   * in the account and the policies have to restrict the login method themselves.
   */
  accessLoginMethods?: LoginMethod[];
  /** Explicit identity provider IDs, only needed when auto-detection is ambiguous. */
  accessIdpIds?: LoginMethodIdpIds;
  /**
   * Custom domains served without Cloudflare Access, per Pages project. Only
   * these exact hostnames are left open; the project's `<project>.pages.dev`
   * hosts (production, deployment and preview URLs) and any other custom domain
   * stay protected by the selected policy. Operator-owned; never set by tool callers.
   */
  publicDomains?: Record<string, string[]>;
}

/** A plain hostname: no wildcard, no port, no trailing dot; punycode TLDs allowed. */
export const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const projectName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,57}$/);
const hostname = z
  .string()
  .transform((host) => host.trim().toLowerCase())
  .pipe(z.string().regex(hostnamePattern))
  .refine((host) => !host.endsWith(".pages.dev"), "pages.dev hosts cannot be public domains");
const publicDomainsSchema = z.record(projectName, z.array(hostname).min(1));

/** Parses PUBLIC_DOMAINS, a JSON object mapping a Pages project to its public hostnames. */
export function readPublicDomains(raw: string | undefined): Record<string, string[]> {
  const text = raw?.trim();
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (value && typeof value === "object")
    Object.keys(value).forEach((key) => projectName.parse(key));
  const parsed = publicDomainsSchema.parse(value);
  return Object.fromEntries(
    Object.entries(parsed).map(([project, hosts]) => [project, [...new Set(hosts)]]),
  );
}

/** The custom domains the operator allows this project to serve without Access. */
export function publicDomainsOf(config: AccessPolicyConfig, project: string): string[] {
  const domains = config.publicDomains ?? {};
  return Object.hasOwn(domains, project) ? domains[project]! : [];
}

const methodSchema = z.enum(LOGIN_METHODS);

function readLoginMethods(env: NodeJS.ProcessEnv): LoginMethod[] | undefined {
  const raw = env.ACCESS_LOGIN_METHODS?.trim();
  if (!raw) return undefined;
  const methods = raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((entry) => {
      const parsed = methodSchema.safeParse(entry.toLowerCase());
      // Do not echo the value: configuration errors end up in logs.
      if (!parsed.success)
        throw new Error(
          `Unsupported ACCESS_LOGIN_METHODS entry. Allowed: ${LOGIN_METHODS.join(", ")}.`,
        );
      return parsed.data;
    });
  return [...new Set(methods)];
}

function readIdpIds(
  env: NodeJS.ProcessEnv,
  methods: LoginMethod[] | undefined,
): LoginMethodIdpIds | undefined {
  const ids: LoginMethodIdpIds = {};
  for (const method of LOGIN_METHODS) {
    const name = `ACCESS_${method.toUpperCase()}_IDP_ID`;
    const raw = env[name]?.trim();
    if (!raw) continue;
    // An ID for a method that is not enabled would be silently ignored; fail loudly.
    if (!methods?.includes(method))
      throw new Error(`${name} is set but "${method}" is not listed in ACCESS_LOGIN_METHODS.`);
    ids[method] = policyId.parse(raw);
  }
  return Object.keys(ids).length ? ids : undefined;
}

/** Operator-owned configuration only; never accept file paths from tool arguments. */
export function readAccessPolicies(env: NodeJS.ProcessEnv = process.env): AccessPolicyConfig {
  let fromFile: Record<string, string> = {};
  const file = env.ACCESS_POLICIES_FILE?.trim();
  if (file) {
    if (statSync(file).size > 1024 * 1024) throw new Error("Access policy file exceeds 1 MiB.");
    fromFile = readCatalog(parse(readFileSync(file, "utf8"), { maxAliasCount: 0 }));
  }
  const inline = env.ACCESS_POLICIES?.trim();
  const fromEnv = inline ? readCatalog(JSON.parse(inline)) : {};
  const rawDefault = env.DEFAULT_ACCESS_POLICY_ID?.trim();
  const accessLoginMethods = readLoginMethods(env);
  return {
    accessPolicies: { ...fromFile, ...fromEnv },
    defaultAccessPolicyId: rawDefault ? policyId.parse(rawDefault) : undefined,
    accessLoginMethods,
    accessIdpIds: readIdpIds(env, accessLoginMethods),
    publicDomains: readPublicDomains(env.PUBLIC_DOMAINS),
  };
}

export function resolveAccessPolicy(config: AccessPolicyConfig, name?: string): string | undefined {
  if (name !== undefined) {
    const policies = config.accessPolicies ?? {};
    if (!Object.hasOwn(policies, name)) throw new Error(`Unknown access policy name: ${name}`);
    return policies[name];
  }
  return config.defaultAccessPolicyId;
}
