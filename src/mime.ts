import { extname } from "node:path";

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  xml: "application/xml",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** Best-effort content type from a file path, defaulting to octet-stream. */
export function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).substring(1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}
