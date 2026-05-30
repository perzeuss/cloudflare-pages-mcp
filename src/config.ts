import { z } from "zod";

/**
 * Centralised, validated configuration loaded from environment variables.
 *
 * All environment access happens here so the rest of the codebase can depend on
 * a strongly-typed, validated config object instead of reading `process.env`
 * directly.
 */

/** A required, non-empty string env var with a consistent error message. */
const requiredEnv = (name: string) =>
  z
    .string({
      required_error: `${name} is required`,
      invalid_type_error: `${name} is required`,
    })
    .min(1, `${name} is required`);

const ConfigSchema = z.object({
  cloudflareApiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
  cloudflareAccountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate the configuration from an environment object (defaults to
 * `process.env`). Fails loudly, listing every missing/invalid variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse({
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
  });

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(
      `Invalid configuration:\n${issues}\n\n` +
        "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the MCP server environment.",
    );
  }

  return result.data;
}
