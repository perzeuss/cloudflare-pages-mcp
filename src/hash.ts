import { hash as blake3hash } from "blake3-wasm";
import { extname } from "node:path";

/**
 * Computes the asset hash exactly the way Wrangler / Cloudflare Pages does, so
 * the values match what Cloudflare expects in the deployment manifest and in
 * the asset upload/check-missing calls.
 *
 * Reference (wrangler `packages/wrangler/src/pages/hash.ts`):
 *   blake3hash(base64Contents + extension).toString("hex").slice(0, 32)
 *
 * `extension` is the file extension WITHOUT the leading dot.
 */
export function hashContent(contents: Buffer, filePath: string): string {
  const base64Contents = contents.toString("base64");
  const extension = extname(filePath).substring(1);
  return blake3hash(base64Contents + extension)
    .toString("hex")
    .slice(0, 32);
}
