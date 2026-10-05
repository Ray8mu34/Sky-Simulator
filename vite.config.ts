import { defineConfig } from 'vite';
import { build as esbuild } from 'esbuild';
import { resolve } from 'node:path';

const workerEntries: Record<string, string> = {
  'virtual:sky-worker': 'src/platform/science-worker.ts',
  'virtual:sky-day-worker': 'src/platform/solar-day-worker.ts',
};

export default defineConfig({
  base: './',
  define: { __SKY_PORTABLE__: 'false' },
  plugins: [{
    name: 'sky-worker-sources',
    resolveId(id) { return workerEntries[id] ? `\0${id}` : null; },
    async load(id) {
      const entry = workerEntries[id.slice(1)];
      if (!id.startsWith('\0') || !entry) return null;
      const result = await esbuild({ entryPoints: [entry], bundle: true, write: false, format: 'iife', target: 'es2020', minify: true, metafile: true });
      for (const path of Object.keys(result.metafile.inputs)) if (!path.startsWith('node_modules/')) this.addWatchFile(resolve(path));
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'es2020', assetsInlineLimit: 0 },
});
