import { firefox } from '@playwright/test';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const outDir = resolve('qa/browser-environment'), expectedRoot = resolve('.qa-browsers');
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, expectedRoot, 'Firefox smoke must use the explicit project-local runtime root.');
await mkdir(outDir, { recursive: true });
const executable = firefox.executablePath();
assert.ok(executable.startsWith(`${expectedRoot}\\`));
const report = { status: 'running', startedAt: new Date().toISOString(), scope: 'Version/startup only: blank page, no app functional/GPU/PWA acceptance.',
  playwrightVersion: '1.63.0', runtimeRevision: '1543', browserPath: executable, runtimeRoot: expectedRoot,
  sourceUrl: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1543/firefox-win64.zip',
  installLog: resolve(outDir, 'firefox-install.log'), helperRuntimes: ['ffmpeg-1011', 'winldd-1007'],
  globalConfigurationChanged: false, dependencyVersionsChanged: false };
let browser;
try {
  assert.equal((await stat(executable)).isFile(), true);
  report.executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  browser = await firefox.launch({ headless: true });
  report.browserVersion = browser.version(); assert.equal(report.browserVersion, '155.0');
  const page = await browser.newPage();
  report.environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, platform: navigator.platform, url: location.href }));
  assert.equal(report.environment.url, 'about:blank');
  report.status = 'passed-project-local-firefox-version-smoke';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await browser?.close(); report.finishedAt = new Date().toISOString(); report.browserClosed = true;
  await writeFile(resolve(outDir, 'firefox-runtime-smoke.json'), JSON.stringify(report, null, 2));
  console.log(`${report.status}; ${resolve(outDir, 'firefox-runtime-smoke.json')}`);
}
