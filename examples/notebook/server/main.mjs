import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep, extname } from "node:path";
import { openNotebook, fail } from "./store.mjs";

const base = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 5173);
const notebook = await openNotebook(process.env.NOTEBOOK_DIR ?? resolve(base, ".local/notebook"));
const dev = process.argv.includes("--dev");
const dist = resolve(base, "dist");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const send = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

let vite;
const server = createServer(async (req, res) => {
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host ?? ""))
      fail("Use the local notebook address.", 403);
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      if (req.method === "GET" && path === "/api/workspace") return send(res, await notebook.workspace());
      if (req.method === "GET" && /^\/api\/history\/\d+$/.test(path))
        return send(res, await notebook.history(path.split("/").pop()));
      if (req.method === "POST" && path === "/api/command") {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
          fail("Different origin.", 403);
        if (!req.headers["content-type"]?.startsWith("application/json")) fail("Expected JSON.", 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) fail("Document is too large.", 413);
          chunks.push(chunk);
        }
        let action;
        try {
          action = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          fail("Invalid JSON.");
        }
        return send(res, { id: await notebook.command(action) });
      }
      return send(res, { error: "Unknown notebook endpoint." }, 404);
    }
    if (vite) return vite.middlewares(req, res);
    let file = resolve(dist, "." + decodeURIComponent(path));
    if (!file.startsWith(dist + sep) && file !== dist) fail("Invalid path.");
    if (!extname(file)) file = resolve(dist, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    const status = err.status ?? (err.code === "ENOENT" ? 404 : 500);
    if (status === 500) console.error(err);
    send(res, { error: status === 500 ? "Could not complete the notebook request." : err.message }, status);
  }
});
if (dev) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({ root: base, server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
}
server.listen(port, "127.0.0.1", () =>
  console.log(`Notebook running at http://127.0.0.1:${server.address().port}`),
);
async function close() {
  await vite?.close();
  server.close(() => {
    notebook.close();
    process.exit(0);
  });
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
