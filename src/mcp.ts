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
import { CloudflareClient } from "./cloudflare.js";
import { collectFiles } from "./files.js";

export interface ServerContext {
  config: Config;
  client: CloudflareClient;
}

const inlineFileSchema = z.object({
  path: z.string().describe('Site-relative path, e.g. "index.html" or "assets/app.css".'),
  content: z.string().describe("File content."),
  encoding: z
    .enum(["utf8", "base64"])
    .optional()
    .describe(
      'Encoding of `content`. Use "base64" for binary assets (images, fonts). Default: utf8.',
    ),
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Runs a handler and maps its string output / thrown errors into an MCP result. */
async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

function liveUrls(project: { name: string; subdomain?: string }, deploymentUrl?: string): string {
  const lines: string[] = [];
  if (deploymentUrl) lines.push(`Deployment URL: ${deploymentUrl}`);
  lines.push(`Production URL: https://${project.subdomain || `${project.name}.pages.dev`}`);
  return lines.join("\n");
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
      annotations: { title: "Create Cloudflare Pages project" },
      description:
        "Create an empty Direct Upload Cloudflare Pages project. The project name becomes the <name>.pages.dev subdomain (lowercase letters, digits and hyphens). Use `deploy` afterwards to publish files. `deploy` can also auto-create the project, so calling this first is optional.",
      inputSchema: {
        name: z.string().describe("Project name; also the *.pages.dev subdomain."),
        production_branch: z
          .string()
          .optional()
          .describe('Production branch name. Default: "main".'),
      },
    },
    async (args) =>
      run(async () => {
        const project = await client.createProject(args.name, args.production_branch ?? "main");
        return `Created project "${project.name}".\n${liveUrls(project)}`;
      }),
  );

  server.registerTool(
    "deploy",
    {
      annotations: { title: "Deploy files to Cloudflare Pages" },
      description:
        "Upload files and create a deployment, publishing a live site. Provide the complete set of site files inline via `files` (e.g. Claude-generated HTML/CSS/JS, and binary assets as base64). Creates the project automatically if it does not exist (unless create_if_missing is false). Returns the live URLs.",
      inputSchema: {
        project_name: z.string().describe("Target Pages project name."),
        files: z
          .array(inlineFileSchema)
          .min(1)
          .describe(
            'The site files to deploy, defined inline. Each entry has a site-relative `path` and its `content` (use encoding "base64" for binary assets).',
          ),
        branch: z
          .string()
          .optional()
          .describe(
            "Deployment branch. Omit (or use the production branch) for a production deploy; any other value creates a preview deployment.",
          ),
        create_if_missing: z
          .boolean()
          .optional()
          .describe("Create the project if it does not exist yet. Default: true."),
        production_branch: z
          .string()
          .optional()
          .describe('Production branch used when auto-creating the project. Default: "main".'),
      },
    },
    async (args) =>
      run(async () => {
        const files = await collectFiles({ files: args.files });

        if (args.create_if_missing !== false && !(await client.projectExists(args.project_name))) {
          await client.createProject(args.project_name, args.production_branch ?? "main");
        }

        const { deployment, uploaded, total } = await client.deploy({
          projectName: args.project_name,
          files,
          branch: args.branch,
        });

        return [
          `Deployed ${files.length} file(s) to "${args.project_name}" (${uploaded}/${total} assets newly uploaded).`,
          liveUrls({ name: args.project_name }, deployment.url),
          `Deployment ID: ${deployment.id}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "list_projects",
    {
      annotations: { title: "List Cloudflare Pages projects" },
      description: "List all Cloudflare Pages projects in the account.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const projects = await client.listProjects();
        if (projects.length === 0) return "No Pages projects found.";
        return projects
          .map((p) => `- ${p.name} → https://${p.subdomain || `${p.name}.pages.dev`}`)
          .join("\n");
      }),
  );

  server.registerTool(
    "get_project",
    {
      annotations: { title: "Get Cloudflare Pages project" },
      description: "Get details for a single Cloudflare Pages project, including its live domains.",
      inputSchema: {
        name: z.string().describe("Project name."),
      },
    },
    async (args) =>
      run(async () => {
        const p = await client.getProject(args.name);
        const domains = p.domains?.length ? p.domains.join(", ") : "(none)";
        return [
          `Project: ${p.name}`,
          liveUrls(p),
          `Custom domains: ${domains}`,
          `Production branch: ${p.production_branch ?? "main"}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "delete_project",
    {
      annotations: {
        title: "Delete Cloudflare Pages project",
        destructiveHint: true,
      },
      description:
        "Permanently delete a Cloudflare Pages project and all its deployments. This cannot be undone.",
      inputSchema: {
        name: z.string().describe("Project name to delete."),
      },
    },
    async (args) =>
      run(async () => {
        await client.deleteProject(args.name);
        return `Deleted project "${args.name}".`;
      }),
  );

  return server;
}
