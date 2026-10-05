import { build } from 'esbuild';

export const workerEntries = {
  'virtual:sky-worker': 'src/platform/science-worker.ts',
  'virtual:sky-day-worker': 'src/platform/solar-day-worker.ts',
};

export async function bundleWorkerSources() {
  const sources = new Map();
  for (const [id, entry] of Object.entries(workerEntries)) {
    const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', target: 'es2020', minify: true });
    sources.set(id, result.outputFiles[0]);
  }
  return sources;
}

export function workerEvidence(sources) {
  const workers = [...sources].map(([id, output]) => ({ id, sourceBytes: output.contents.length }));
  return { workerCountMax: workers.length, workerBytes: workers.reduce((sum, worker) => sum + worker.sourceBytes, 0), workers };
}
