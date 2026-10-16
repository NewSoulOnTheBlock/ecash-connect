/** Serves the built demo at http://localhost:5174 (bun run build first). */
import { join } from 'node:path';
const dist = join(import.meta.dir, 'dist');
const server = Bun.serve({
  port: Number(process.env.PORT ?? 5174),
  fetch(req) {
    const path = new URL(req.url).pathname;
    return new Response(Bun.file(join(dist, path === '/' ? 'index.html' : path)));
  },
});
console.log(`demo at http://localhost:${server.port}`);
