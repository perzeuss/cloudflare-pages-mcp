/**
 * Builds the MCP server instance and registers the Cloudflare Pages tools.
 *
 * A fresh server is created per request (stateless Streamable HTTP), but the
 * underlying CloudflareClient is shared via the ServerContext so each request
 * doesn't have to reconstruct it from the environment.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import { CloudflareClient, CloudflareError, type DeploymentResult } from "./cloudflare.js";
import { collectFiles } from "./files.js";
import { logger } from "./logger.js";

export interface ServerContext {
  config: Config;
  client: CloudflareClient;
}

const createProjectSchema = {
  name: z
    .string()
    .min(1)
    .max(58)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Project name must be lowercase alphanumeric with hyphens")
    .describe("Project name; becomes <name>.pages.dev"),
};

const deploySchema = {
  project: z.string().min(1).describe("Existing Cloudflare Pages project name to deploy to"),
  directory: z.string().min(1).describe("Absolute path to the directory of static files to deploy"),
  branch: z.string().optional().describe("Optional git-style branch label for the deployment"),
};

const listProjectsSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of projects to return"),
};

const getProjectSchema = {
  project: z.string().min(1).describe("Project name to fetch details for"),
};

const deleteProjectSchema = {
  project: z.string().min(1).describe("Project name to delete"),
};

function formatDeployment(result: DeploymentResult): string {
  const lines = [`Deployed to ${result.url}`, `Project: ${result.project}`];
  if (result.deploymentId) lines.push(`Deployment ID: ${result.deploymentId}`);
  return lines.join("\n");
}

function toolError(err: unknown) {
  const message =
    err instanceof CloudflareError ? err.message : err instanceof Error ? err.message : String(err);
  logger.error("Tool execution failed", { error: message });
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

/**
 * Run a tool handler and wrap any thrown error in an MCP error result so the
 * connector surfaces a readable message instead of a transport-level failure.
 */
async function run(fn: () => Promise<{ content: Array<{ type: "text"; text: string }> }>) {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}

export function buildMcpServer(ctx: ServerContext): McpServer {
  const { client } = ctx;

  const server = new McpServer({
    name: "cloudflare-pages-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "create_project",
    {
      title: "Create Cloudflare Pages project",
      description:
        "Create a new Cloudflare Pages project. The project name becomes the subdomain: <name>.pages.dev.",
      inputSchema: createProjectSchema,
    },
    async (args) =>
      run(async () => {
        const project = await client.createProject(args.name);
        return {
          content: [
            {
              type: "text",
              text: `Created project "${project.name}" -> https://${project.subdomain}`,
            },
          ],
        };
      }),
  );

  server.registerTool(
    "deploy",
    {
      title: "Deploy files to Cloudflare Pages",
      description:
        "Upload a directory of static files to a Cloudflare Pages project and publish a deployment.",
      inputSchema: deploySchema,
    },
    async (args) =>
      run(async () => {
        const files = await collectFiles(args.directory);
        const result = await client.deploy(args.project, files, args.branch);
        return { content: [{ type: "text", text: formatDeployment(result) }] };
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Cloudflare Pages projects",
      description: "List existing Cloudflare Pages projects in the account.",
      inputSchema: listProjectsSchema,
    },
    async (args) =>
      run(async () => {
        const projects = await client.listProjects(args.limit);
        const text =
          projects.length === 0
            ? "No projects found."
            : projects.map((p) => `- ${p.name} (https://${p.subdomain})`).join("\n");
        return { content: [{ type: "text", text }] };
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get Cloudflare Pages project",
      description: "Fetch details for a single Cloudflare Pages project.",
      inputSchema: getProjectSchema,
    },
    async (args) =>
      run(async () => {
        const project = await client.getProject(args.project);
        return {
          content: [{ type: "text", text: JSON.stringify(project, null, 2) }],
        };
      }),
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete Cloudflare Pages project",
      description: "Delete a Cloudflare Pages project permanently.",
      inputSchema: deleteProjectSchema,
    },
    async (args) =>
      run(async () => {
        await client.deleteProject(args.project);
        return {
          content: [{ type: "text", text: `Deleted project "${args.project}".` }],
        };
      }),
  );

  return server;
}
