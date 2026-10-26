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
export interface AccessPolicyConfig {
  accessPolicies?: Record<string, string>;
  defaultAccessPolicyId?: string;
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
  return {
    accessPolicies: { ...fromFile, ...fromEnv },
    defaultAccessPolicyId: rawDefault ? policyId.parse(rawDefault) : undefined,
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
