import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { workerEntries } from './build-workers.mjs';

const outDir = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/m5a-platform/worker-boundary');
await mkdir(outDir, { recursive: true });
const workers = [];
for (const [id, entry] of Object.entries(workerEntries)) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', target: 'es2020', minify: true, metafile: true });
  const inputs = Object.keys(built.metafile.inputs), output = built.outputFiles[0];
  assert.ok(!inputs.some(input => /^src\/data\//.test(input)), `${id} must not bundle the star catalog or search resolver`);
  workers.push({ id, entry, bytes: output.contents.length, sha256: createHash('sha256').update(output.contents).digest('hex'), inputs });
}
assert.equal(workers.length, 2);
const report = { status: 'passed-source-bundle-boundary', checkedAt: new Date().toISOString(), workerCountMax: 2,
  workerBytes: workers.reduce((sum, worker) => sum + worker.bytes, 0), workers,
  limitation: 'In-memory production-format bundles; this does not replace browser Worker execution or a final release build.' };
await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${report.status}; ${report.workerBytes} bytes; ${resolve(outDir, 'report.json')}`);
