/** Builds the unpacked extension into dist/ (load it from chrome://extensions). */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir;
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

async function bundle(entry: string, format: 'esm' | 'iife') {
  const r = await Bun.build({
    entrypoints: [join(root, 'src', entry)],
    outdir: out,
    target: 'browser',
    format,
    minify: false,
    define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 19).replace('T', ' ')) },
    sourcemap: 'none',
  });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    throw new Error(`build failed: ${entry}`);
  }
}

// Content scripts cannot be modules; the worker and popup are.
await bundle('inpage.ts', 'iife');
await bundle('content.ts', 'iife');
await bundle('background.ts', 'esm');
await bundle('popup.ts', 'esm');

cpSync(join(root, 'static'), out, { recursive: true });
console.log(`built ${out}`);
