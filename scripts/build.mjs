import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const publicDir = join(root, "public");
const distDir = join(root, "dist");
const serverDir = join(distDir, "server");
const clientDir = join(distDir, "client");
if (distDir !== join(root, "dist")) throw new Error("Unexpected build directory");

const rootAssets = ["index.html", "styles.css", "app.js", "core.js", "manifest.webmanifest", "service-worker.js"];
const publicAssets = ["og.png", "icon-192.png", "icon-512.png"];
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png"
};

await Promise.all(rootAssets.map((file) => readFile(join(root, file))));
await Promise.all(publicAssets.map((file) => readFile(join(publicDir, file))));
await rm(distDir, { recursive: true, force: true });
await mkdir(serverDir, { recursive: true });
await mkdir(clientDir, { recursive: true });
await Promise.all(rootAssets.map((file) => cp(join(root, file), join(clientDir, file))));
await Promise.all(publicAssets.map((file) => cp(join(publicDir, file), join(clientDir, file))));
const pagesOrigin = process.env.SITE_ORIGIN || "https://camilo31-svg.github.io/anhad-meditacion";
const clientHtml = (await readFile(join(root, "index.html"), "utf8")).replaceAll("__SITE_ORIGIN__", pagesOrigin);
await writeFile(join(clientDir, "index.html"), clientHtml, "utf8");
await writeFile(join(clientDir, ".nojekyll"), "", "utf8");

const assets = [];
for (const file of rootAssets) {
  const body = (await readFile(join(root, file))).toString("base64");
  assets.push([`/${file}`, { body, contentType: mimeTypes[extname(file)] || "application/octet-stream" }]);
}
for (const file of publicAssets) {
  const body = (await readFile(join(publicDir, file))).toString("base64");
  assets.push([`/${file}`, { body, contentType: mimeTypes[extname(file)] || "application/octet-stream" }]);
}

const worker = String.raw`const ASSETS = new Map(${JSON.stringify(assets)});
function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    let asset = ASSETS.get(pathname);
    if (!asset && !pathname.includes(".")) asset = ASSETS.get("/index.html");
    if (!asset) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "content-type": asset.contentType,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    });
    headers.set("cache-control", pathname === "/service-worker.js" ? "no-cache" : pathname.endsWith(".png") ? "public, max-age=604800, immutable" : "public, max-age=300");
    const decoded = decodeBase64(asset.body);
    if (pathname === "/index.html") {
      const html = new TextDecoder().decode(decoded).replaceAll("__SITE_ORIGIN__", url.origin);
      return new Response(html, { status: 200, headers });
    }
    return new Response(decoded, { status: 200, headers });
  }
};`;

await writeFile(join(serverDir, "index.js"), worker, "utf8");
console.log(`Built ${assets.length} assets into ${relative(root, join(serverDir, "index.js"))}`);

