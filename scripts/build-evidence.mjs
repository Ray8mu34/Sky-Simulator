import { readdir, readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export async function attribution() {
  const sections = [];
  try { sections.push(['assets/assets-manifest.json', await readFile('assets/assets-manifest.json', 'utf8')]); } catch { /* data generation may still be in progress */ }
  try {
    for (const name of (await readdir('assets/licenses')).sort()) {
      if (/\.(txt|md|json)$/i.test(name)) sections.push([`assets/licenses/${name}`, await readFile(`assets/licenses/${name}`, 'utf8')]);
    }
  } catch { /* explicitly report incomplete attribution below */ }
  const dependencyCredits = [];
  for (const [name, path] of [['Astronomy Engine 2.1.19', 'node_modules/astronomy-engine/astronomy.js'], ['Three.js 0.186.1', 'node_modules/three/LICENSE']]) {
    const raw = await readFile(path, 'utf8');
    const license = path.endsWith('astronomy.js') ? raw.match(/^\/\*\*[\s\S]*?\*\//)?.[0] : raw;
    if (!license?.includes('Permission is hereby granted')) throw new Error(`${name}: bundled license notice not found`);
    dependencyCredits.push([name, license]);
  }
  return { complete: sections.some(([path]) => path.endsWith('assets-manifest.json')) && sections.length >= 2, text: [...sections, ...dependencyCredits].map(([title, text]) => `${title}\n${text}`).join('\n\n') };
}
export async function copyAttribution(outDir) {
  const credits = await attribution();
  await mkdir(`${outDir}/credits`, { recursive: true });
  await writeFile(`${outDir}/credits/attribution.txt`, credits.text);
  try { await cp('assets/assets-manifest.json', `${outDir}/credits/assets-manifest.json`); } catch { /* reported */ }
  try { await cp('assets/licenses', `${outDir}/credits/licenses`, { recursive: true }); } catch { /* reported */ }
  return credits;
}
export async function packageSizes(dir) {
  let rawBytes = 0, gzipBytes = 0;
  const files = [];
  async function walk(root) {
    for (const name of (await readdir(root)).sort()) {
      const path = join(root, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else {
        const bytes = await readFile(path);
        const compressed = gzipSync(bytes).length;
        rawBytes += bytes.length; gzipBytes += compressed;
        files.push({ path: path.replaceAll('\\', '/'), bytes: bytes.length, gzipBytes: compressed, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(dir);
  return { rawBytes, gzipBytes, gzipMethod: 'sum of each distributable file compressed separately with node gzipSync defaults', files };
}
