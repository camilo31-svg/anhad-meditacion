import { createServer } from "node:http";
import { stat } from "node:fs/promises";

await import("./build.mjs");
const workerPath = new URL("../dist/server/index.js", import.meta.url);
let worker;
let workerVersion = 0;

async function currentWorker() {
  const version = (await stat(workerPath)).mtimeMs;
  if (!worker || version !== workerVersion) {
    worker = (await import(new URL(`../dist/server/index.js?dev=${version}`, import.meta.url))).default;
    workerVersion = version;
  }
  return worker;
}

await currentWorker();
const port = Number.parseInt(process.env.PORT || "4173", 10);
const host = "127.0.0.1";

createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    const activeWorker = await currentWorker();
    const workerResponse = await activeWorker.fetch(new Request(requestUrl, { method: request.method, headers: request.headers }));
    response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers));
    response.end(Buffer.from(await workerResponse.arrayBuffer()));
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("No se pudo cargar Anhad.");
  }
}).listen(port, host, () => console.log(`Local: http://${host}:${port}`));

