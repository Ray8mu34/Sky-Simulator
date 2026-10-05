import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { attribution } from './build-evidence.mjs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { bundleWorkerSources, workerEvidence } from './build-workers.mjs';

const workers = await bundleWorkerSources();
const mimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.json': 'application/json' };
const output = await build({
  entryPoints: ['src/main.ts'], bundle: true, write: false, outfile: 'portable.js', format: 'iife', target: 'es2020', minify: true,
  define: { __SKY_PORTABLE__: 'true', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.bin': 'dataurl' },
  plugins: [{ name: 'all-local-resources', setup(build) {
    build.onResolve({ filter: /^virtual:sky-(?:day-)?worker$/ }, args => ({ path: args.path, namespace: 'worker-inline' }));
    build.onLoad({ filter: /.*/, namespace: 'worker-inline' }, args => ({ contents: `export default ${JSON.stringify(workers.get(args.path).text)};`, loader: 'js' }));
    build.onResolve({ filter: /\?(url|inline|raw)$/ }, args => ({ path: resolve(args.resolveDir, args.path.split('?')[0]), namespace: args.path.endsWith('?raw') ? 'local-raw' : 'local-data' }));
    build.onLoad({ filter: /.*/, namespace: 'local-raw' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`, loader: 'js' }));
    build.onLoad({ filter: /.*/, namespace: 'local-data' }, async args => ({ contents: `export default ${JSON.stringify(`data:${mimes[extname(args.path)] ?? 'application/octet-stream'};base64,${(await readFile(args.path)).toString('base64')}`)};`, loader: 'js' }));
  } }],
});
const js = output.outputFiles.find(f => f.path.endsWith('.js'))?.text;
const css = output.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
if (!js) throw new Error('便携构建没有JavaScript输出');
const source = await readFile('index.html', 'utf8');
const credits = await attribution();
const entryTag = /<script type="module" src="\/src\/main\.ts"><\/script>/;
if (!entryTag.test(source)) throw new Error('未找到便携构建源入口');
if (/<script[^>]*\bsrc=|<link[^>]*\brel=["']stylesheet/i.test(source.replace(entryTag, ''))) throw new Error('便携模板仍有外部脚本或CSS');
const html = source.replace(entryTag, () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style><script>${js.replace(/<\/script/gi, '<\\/script')}</script>`).replace('</body>', () => `<!-- Bundled asset and dependency credits\n${credits.text.replaceAll('--', '—')}\n--></body>`);
await mkdir('dist-portable', { recursive: true });
await writeFile('dist-portable/三维全景夜空.html', html);
const bytes = Buffer.byteLength(html);
const report = { status: 'built-not-browser-verified', format: 'classic-iife', bytes, gzipBytes: gzipSync(html).length, sha256: createHash('sha256').update(html).digest('hex'), ...workerEvidence(workers), budgetBytesMax: 16_000_000, withinBudget: bytes <= 16_000_000, attributionComplete: credits.complete, builtAt: new Date().toISOString() };
await writeFile('dist-portable/build-report.json', JSON.stringify(report, null, 2));
console.log(`Portable HTML: dist-portable/三维全景夜空.html (${report.bytes.toLocaleString()} bytes; browser acceptance still required)`);
if (!report.withinBudget) throw new Error('便携HTML超过16MB预算；详见build-report.json');
