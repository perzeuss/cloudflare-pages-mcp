import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Cloudflare Pages limits for a single Direct Upload deployment. */
export const MAX_FILES = 20_000;
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MiB

/** Directory/file names skipped when walking a directory. */
const SKIP = new Set([".git", "node_modules", ".wrangler", ".DS_Store", "Thumbs.db"]);

export interface DeployFile {
  /** Normalized site path, always starting with "/" (e.g. "/index.html"). */
  path: string;
  contents: Buffer;
}

export interface InlineFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/** Normalize an arbitrary input path into a leading-slash POSIX site path. */
export function normalizePath(input: string): string {
  const cleaned = input
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  return "/" + cleaned;
}

async function walk(root: string, dir: string, out: DeployFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push({ path: normalizePath(relative(root, full)), contents: await readFile(full) });
    }
  }
}

/**
 * Collects the files to deploy from inline definitions and/or a directory.
 * Inline files take precedence over directory files with the same path.
 * Throws if the result is empty or violates Cloudflare's limits.
 */
export async function collectFiles(opts: {
  files?: InlineFile[];
  directory?: string;
}): Promise<DeployFile[]> {
  const byPath = new Map<string, DeployFile>();

  if (opts.directory) {
    const collected: DeployFile[] = [];
    await walk(opts.directory, opts.directory, collected);
    for (const file of collected) byPath.set(file.path, file);
  }

  for (const file of opts.files ?? []) {
    const contents = Buffer.from(file.content, file.encoding ?? "utf8");
    byPath.set(normalizePath(file.path), { path: normalizePath(file.path), contents });
  }

  const result = [...byPath.values()];

  if (result.length === 0) {
    throw new Error("No files to deploy. Provide `files` and/or a `directory` containing files.");
  }
  if (result.length > MAX_FILES) {
    throw new Error(
      `Too many files: ${result.length} (Cloudflare Pages allows up to ${MAX_FILES}).`,
    );
  }
  for (const file of result) {
    if (file.contents.byteLength > MAX_FILE_SIZE) {
      throw new Error(
        `File ${file.path} is ${file.contents.byteLength} bytes, exceeding the 25 MiB per-file limit.`,
      );
    }
  }

  return result;
}
