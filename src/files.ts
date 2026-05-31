/** Cloudflare Pages limits for a single Direct Upload deployment. */
export const MAX_FILES = 20_000;
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MiB

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

/** Convert a single inline file into a normalized, size-validated DeployFile. */
export function inlineToDeployFile(file: InlineFile): DeployFile {
  const path = normalizePath(file.path);
  const contents = Buffer.from(file.content, file.encoding ?? "utf8");
  if (contents.byteLength > MAX_FILE_SIZE) {
    throw new Error(
      `File ${path} is ${contents.byteLength} bytes, exceeding the 25 MiB per-file limit.`,
    );
  }
  return { path, contents };
}

/**
 * Collects the files to deploy from inline definitions.
 *
 * Files are always provided inline by the caller (e.g. Claude-generated
 * HTML/CSS/JS). This server is a remote connector, so it deliberately does NOT
 * read from a local directory: that would walk the *server's* filesystem, not
 * the caller's, which is both useless and a disclosure risk.
 *
 * Later files win over earlier ones on path conflicts. Throws if the result is
 * empty or violates Cloudflare's limits.
 */
export async function collectFiles(opts: { files?: InlineFile[] }): Promise<DeployFile[]> {
  const byPath = new Map<string, DeployFile>();

  for (const file of opts.files ?? []) {
    const deployFile = inlineToDeployFile(file);
    byPath.set(deployFile.path, deployFile);
  }

  const result = [...byPath.values()];

  if (result.length === 0) {
    throw new Error("No files to deploy. Provide a non-empty `files` array.");
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
