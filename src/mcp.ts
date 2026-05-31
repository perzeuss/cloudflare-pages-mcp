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
import { collectFiles, normalizePath } from "./files.js";
import { signToken } from "./security.js";
import { StagingStore } from "./staging.js";

/** How long a signed upload URL is valid, in seconds. */
const UPLOAD_URL_TTL_SECONDS = 30 * 60;

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
  const { client, staging, config } = ctx;

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
        "Upload files and create a deployment in a single call, publishing a live site. Provide the complete set of site files inline via `files` (e.g. Claude-generated HTML/CSS/JS, and binary assets as base64). Creates the project automatically if it does not exist (unless create_if_missing is false). Returns the live URLs. NOTE: a single tool call is bounded by the model's output size — for large sites (many files or thousands of lines) use create_deployment + create_upload_url + publish_deployment instead.",
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
        "Begin an incremental deployment for a large site. Returns a deploy_id. Add files by uploading them from disk: call create_upload_url with a batch of `paths` to get signed URLs, upload every file with the cloudflare-pages-upload skill (or curl), then call publish_deployment to upload everything as ONE Cloudflare deployment. Use this instead of `deploy` when the site is too large to pass in a single call or includes binary assets.",
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
          "Get upload URLs with create_upload_url (batch `paths`), upload files from disk, then call publish_deployment.",
        ].join("\n");
      }),
  );

  server.registerTool(
    "add_files",
    {
      annotations: { title: "DEPRECATED — use create_upload_url + the skill" },
      description:
        "DEPRECATED: do not use. Passing file content inline through the model is no longer supported for staged deployments — it wastes tokens and hits the output-size limit. This tool no longer stages anything; it returns instructions for the supported workflow. Instead use create_upload_url (batch `paths`) to get signed URLs and upload every file from disk via the cloudflare-pages-upload skill, then publish_deployment. For a small, fully model-generated site that is not on disk, use `deploy` (inline) instead.",
      inputSchema: {
        deploy_id: z
          .string()
          .optional()
          .describe("The deploy_id returned by create_deployment (ignored; tool is deprecated)."),
        files: z
          .array(inlineFileSchema)
          .optional()
          .describe("Ignored — add_files no longer stages files."),
      },
    },
    async (args) =>
      run(async () => {
        const did = args.deploy_id ?? "<deploy_id>";
        return [
          "add_files is DEPRECATED and did NOT stage anything.",
          "",
          "Add files to a staged deployment by uploading them from disk instead — this",
          "keeps file bytes out of the model:",
          "",
          `  1. create_upload_url { deploy_id: "${did}", paths: ["index.html", "assets/hero.jpg", ...] }`,
          "       -> returns one signed URL per file (and a ready-to-use manifest).",
          "  2. Upload every local file with the cloudflare-pages-upload skill:",
          "       skills/cloudflare-pages-upload/upload.sh --manifest <file>",
          '     (or PUT each file individually: curl -T <local-file> "<upload-url>")',
          "  3. publish_deployment { deploy_id } to go live.",
          "",
          "If the content is small and entirely model-generated (not on disk), call",
          "`deploy` with inline `files` instead of using a staged deployment.",
          "",
          "See the cloudflare-pages-upload skill (SKILL.md) for the full workflow.",
        ].join("\n");
      }),
  );

  server.registerTool(
    "create_upload_url",
    {
      annotations: { title: "Get signed upload URLs for staged files" },
      description:
        'Get short-lived, signed URLs to upload files into a staged deployment directly from disk WITHOUT passing their bytes through the model. This is the primary way to add files to a staged deployment (text AND binary). Pass `paths` (a batch of site-relative paths) to get one URL per file in a single call. Returns a ready-to-run manifest for the cloudflare-pages-upload skill plus per-file curl commands; upload each local file with an HTTP PUT (the raw file as the body), e.g. `curl -T ./photo.jpg "<upload_url>"`. Requires a deploy_id from create_deployment and that the server has PUBLIC_BASE_URL configured.',
      inputSchema: {
        deploy_id: z.string().describe("The deploy_id returned by create_deployment."),
        paths: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            'Site-relative paths to upload, e.g. ["index.html", "assets/hero.jpg"]. Returns one signed URL per path.',
          ),
        path: z
          .string()
          .optional()
          .describe("Single site-relative path (legacy). Prefer `paths` for batches."),
      },
    },
    async (args) =>
      run(async () => {
        // Validate the staged deployment exists before handing out URLs.
        staging.get(args.deploy_id);

        const base = config.publicBaseUrl;
        if (!base) {
          throw new Error(
            "Uploads require PUBLIC_BASE_URL to be configured on the server so a reachable upload URL can be built.",
          );
        }

        const requested = args.paths ?? (args.path ? [args.path] : []);
        if (requested.length === 0) {
          throw new Error("Provide `paths` (a batch of site-relative paths) or a single `path`.");
        }

        const entries = requested.map((p) => {
          const path = normalizePath(p);
          const token = signToken(
            { t: "upload", did: args.deploy_id, p: path },
            config.uploadSigningSecret,
            UPLOAD_URL_TTL_SECONDS,
          );
          const url = new URL(`/upload/${token}`, base).href;
          return { path, url };
        });

        const ttlMin = Math.round(UPLOAD_URL_TTL_SECONDS / 60);
        const manifest = entries.map((e) => `${e.path}\t${e.url}`).join("\n");
        const curls = entries.map((e) => `  curl -T "${e.path}" "${e.url}"`).join("\n");

        return [
          `Signed upload URLs for ${entries.length} file(s) in staged deployment ${args.deploy_id} (valid ~${ttlMin} min each).`,
          "",
          "Upload every file from disk, then call publish_deployment.",
          "",
          "Recommended: save the manifest below (TSV: site-path <TAB> upload-url) to a",
          "file — replace the left column with the local file path where it differs —",
          "then run the cloudflare-pages-upload skill:",
          "  skills/cloudflare-pages-upload/upload.sh --manifest <file>",
          "",
          "--- manifest ---",
          manifest,
          "--- end manifest ---",
          "",
          "Or upload each file individually:",
          curls,
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
          throw new Error(
            "No files staged. Upload files from disk with create_upload_url before publishing.",
          );
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
