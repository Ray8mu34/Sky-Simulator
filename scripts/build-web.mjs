import { build } from 'vite';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { copyAttribution, packageSizes } from './build-evidence.mjs';
import { bundleWorkerSources, workerEvidence } from './build-workers.mjs';
import { createOfflineWorker } from './build-offline-worker.mjs';

const outDir = resolve(process.env.SKY_BUILD_OUT_DIR ?? 'dist');
const outputRelative = relative(resolve('.'), outDir).replaceAll('\\', '/');
const qaBuildRoot = resolve(process.env.SKY_BUILD_QA_ROOT ?? 'qa/m4b-platform');
const qaRootRelative = relative(resolve('.'), qaBuildRoot).replaceAll('\\', '/');
const qaOutputRelative = relative(qaBuildRoot, outDir).replaceAll('\\', '/');
// Vite clears its output recursively. Permit only the normal dist or named QA build folders.
if (!/^qa\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(qaRootRelative)) throw new Error('显式QA构建根目录必须在本项目qa内且使用命名子目录。');
if (outputRelative !== 'dist' && !/^test-build-[a-z0-9-]+$/i.test(qaOutputRelative)) throw new Error('构建输出必须是dist或已校验QA根目录内的直接test-build-*子目录；拒绝清空其它目录。');
const testTag = process.env.SKY_BUILD_TEST_TAG ?? '';
if (testTag && !/^[a-z0-9-]{1,40}$/i.test(testTag)) throw new Error('测试构建标识只允许40位以内字母数字和连字符。');
await build({ build: { outDir, emptyOutDir: true } });
const credits = await copyAttribution(outDir);
async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...await walk(path));
    else out.push(`./${relative(outDir, path).replaceAll('\\', '/')}`);
  }
  return out;
}
await writeFile(join(outDir, 'manifest.webmanifest'), JSON.stringify({ name: '三维全景夜空', short_name: '全景夜空', start_url: './', scope: './', display: 'standalone', background_color: '#020407', theme_color: '#020407', icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }));
await writeFile(join(outDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="#020407"/><circle cx="96" cy="100" r="45" fill="#244559"/><path d="M144 25v20m-10-10h20M34 62v12m-6-6h12" stroke="#E7E5DC" stroke-width="3"/></svg>');
const html = await readFile(join(outDir, 'index.html'), 'utf8');
await writeFile(join(outDir, 'index.html'), html.replace('</head>', `<link rel="manifest" href="./manifest.webmanifest" />${testTag ? `<meta name="sky-qa-build" content="${testTag}" />` : ''}</head>`));
const files = (await walk(outDir)).sort();
const digest = createHash('sha256');
digest.update(await readFile('scripts/build-offline-worker.mjs'));
for (const file of files) digest.update(await readFile(join(outDir, file)));
const buildId = digest.digest('hex').slice(0, 16);
const taggedHtml = (await readFile(join(outDir, 'index.html'), 'utf8')).replace('</head>', `<meta name="sky-build-id" content="${buildId}" /></head>`);
await writeFile(join(outDir, 'index.html'), taggedHtml);
const core = await Promise.all(files.map(async url => ({ url, sha256: createHash('sha256').update(await readFile(join(outDir, url))).digest('hex') })));
await writeFile(join(outDir, 'sw.js'), createOfflineWorker(buildId, core));
console.log(`Web build ${buildId} with scoped, SHA256-verified offline commit; browser acceptance still required.`);
const sizes = await packageSizes(outDir);
const report = { status: 'built-not-browser-verified', buildId, testTag: testTag || null, output: outDir, offlineProtocol: 'scope-version-sha256-commit-channel-v3', offlineCore: core, ...sizes, ...workerEvidence(await bundleWorkerSources()), attributionComplete: credits.complete, initialTransferCompressedBytesMax: 5_000_000, coreOfflinePackageBytesTarget: 12_000_000, initialCompressedWithinBudget: sizes.gzipBytes <= 5_000_000, coreRawWithinBudget: sizes.rawBytes <= 12_000_000, builtAt: new Date().toISOString() };
await writeFile(join(outDir, 'build-report.json'), JSON.stringify(report, null, 2));
if (!report.initialCompressedWithinBudget || !report.coreRawWithinBudget) throw new Error(`Web资源超过预算；详见${join(outDir, 'build-report.json')}`);
