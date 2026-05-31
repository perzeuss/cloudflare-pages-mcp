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
import { collectFiles, inlineToDeployFile } from "./files.js";
import { StagingStore } from "./staging.js";

export interface ServerContext {
  config: Config;
  client: CloudflareClient;
  staging: StagingStore;
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
  const { client, staging } = ctx;

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
        "Upload files and create a deployment in a single call, publishing a live site. Provide the complete set of site files inline via `files` (e.g. Claude-generated HTML/CSS/JS, and binary assets as base64). Creates the project automatically if it does not exist (unless create_if_missing is false). Returns the live URLs. NOTE: a single tool call is bounded by the model's output size — for large sites (many files or thousands of lines) use create_deployment + add_files + publish_deployment instead.",
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
    "create_deployment",
    {
      annotations: { title: "Start a staged (chunked) deployment" },
      description:
        "Begin an incremental deployment for a large site. Returns a deploy_id. Append files with add_files (call it as many times as needed, in small batches that each fit in one tool call), then call publish_deployment to upload everything as ONE Cloudflare deployment. Use this instead of `deploy` when the site is too large to pass in a single call.",
      inputSchema: {
        project_name: z.string().describe("Target Pages project name."),
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
        const staged = staging.create({
          projectName: args.project_name,
          branch: args.branch,
          createIfMissing: args.create_if_missing !== false,
          productionBranch: args.production_branch ?? "main",
        });
        return [
          `Started staged deployment for "${args.project_name}".`,
          `deploy_id: ${staged.id}`,
          "Add files with add_files (small batches), then call publish_deployment.",
        ].join("\n");
      }),
  );

  server.registerTool(
    "add_files",
    {
      annotations: { title: "Add files to a staged deployment" },
      description:
        "Append a batch of files to a staged deployment created with create_deployment. Call repeatedly with small batches. Files with a path already staged are overwritten. Returns the running file count.",
      inputSchema: {
        deploy_id: z.string().describe("The deploy_id returned by create_deployment."),
        files: z
          .array(inlineFileSchema)
          .min(1)
          .describe("A batch of site files to stage (text, or base64 for binary assets)."),
      },
    },
    async (args) =>
      run(async () => {
        const deployFiles = args.files.map(inlineToDeployFile);
        const staged = staging.addFiles(args.deploy_id, deployFiles);
        return [
          `Added ${deployFiles.length} file(s) to staged deployment ${args.deploy_id}.`,
          `Total staged: ${staged.files.size} file(s).`,
          "Call add_files again for more, or publish_deployment to go live.",
        ].join("\n");
      }),
  );

  server.registerTool(
    "publish_deployment",
    {
      annotations: { title: "Publish a staged deployment" },
      description:
        "Upload all files staged under deploy_id and publish them as a single Cloudflare Pages deployment. Auto-creates the project if needed (per create_deployment's setting). Consumes the staged deployment. Returns the live URLs.",
      inputSchema: {
        deploy_id: z.string().describe("The deploy_id returned by create_deployment."),
      },
    },
    async (args) =>
      run(async () => {
        const staged = staging.get(args.deploy_id);
        const files = [...staged.files.values()];
        if (files.length === 0) {
          throw new Error("No files staged. Add files with add_files before publishing.");
        }

        if (staged.createIfMissing && !(await client.projectExists(staged.projectName))) {
          await client.createProject(staged.projectName, staged.productionBranch);
        }

        const { deployment, uploaded, total } = await client.deploy({
          projectName: staged.projectName,
          files,
          branch: staged.branch,
        });

        staging.delete(args.deploy_id);

        return [
          `Published ${files.length} file(s) to "${staged.projectName}" (${uploaded}/${total} assets newly uploaded).`,
          liveUrls({ name: staged.projectName }, deployment.url),
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
