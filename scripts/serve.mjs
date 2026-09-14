// Servidor estático de desarrollo con las mismas URLs limpias que Vercel (`/demo` → `demo.html`).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const port = Number(process.env.PORT || 8795);
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
};

async function resolve(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [clean, `${clean}.html`, path.join(clean, "index.html")];
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    if (!full.startsWith(root)) continue;
    try {
      if ((await stat(full)).isFile()) return full;
    } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  const file = await resolve(new URL(req.url, "http://localhost").pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
    return;
  }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(file));
}).listen(port, "127.0.0.1", () => console.log(`Address Tracker en http://127.0.0.1:${port}`));
