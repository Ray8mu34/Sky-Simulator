import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startUpdateServer } from './qa-update-server.mjs';

// User-facing round trips use real file controls, downloads, reloads and keyboard
// actions. skyApp is read only here for the existing public rendering diagnostics.
const out = resolve(process.env.SKY_QA_OUT_DIR ?? 'qa/teaching-resilience/final');
await mkdir(out, { recursive: true });
const report = { status: 'running', startedAt: new Date().toISOString(), cases: [], pageErrors: [],
  limits: ['Headless desktop Chrome/Edge; narrow viewport is emulation, not a physical phone.',
    'Portable file storage is browser/file-origin dependent; this run documents this environment only.',
    'Offline uses an isolated Playwright browser context; real service-worker cached responses are verified.',
    'Service-worker update fetches may bypass context offline emulation, so the check-failure case additionally returns a real server-side 404 for sw.js.',
    'The separate qa-updates suite verifies waiting-release activation and old/new package consistency.'] };
const server = await startUpdateServer({ final: resolve(process.env.SKY_QA_BUILD_DIR ?? 'dist') });
server.select('/teaching/', 'final');
const url = `${server.origin}/teaching/`;
const portableUrl = pathToFileURL(resolve(process.env.SKY_QA_PORTABLE_FILE ?? 'dist-portable/三维全景夜空.html')).href;
report.portableSha256 = createHash('sha256').update(await readFile(new URL(portableUrl))).digest('hex');
let browser, context;
const ready = page => page.waitForFunction(() => window.skyApp?.ready && !window.skyApp.diagnostics.scienceDirty
  && window.skyApp.diagnostics.lastRenderedUt === window.skyApp.state.time.utDaysJ2000, undefined, { timeout: 90000 });
async function openPanel(page) {
  if (await page.locator('[data-action="open-time"]').isVisible()
    && await page.locator('[data-action="open-time"]').getAttribute('aria-expanded') !== 'true') {
    await page.locator('[data-action="open-time"]').click();
  }
}
async function expand(page, selector) {
  await openPanel(page);
  if (!await page.locator(selector).evaluate(element => element.open)) await page.locator(`${selector} > summary`).click();
}
async function teaching(page) {
  await expand(page, '.course-equipment'); await expand(page, '.course-tools'); await expand(page, '.landscape-tools');
}
const text = (page, selector) => page.locator(selector).textContent();
async function saved(page, selector) {
  await page.waitForFunction(selector => /已保存|已在此|已恢复|已载入|本地保存成功/.test(document.querySelector(selector)?.textContent ?? '')
    && !/未保存|无法|失败|冲突|正在|其他页面/.test(document.querySelector(selector)?.textContent ?? ''), selector, { timeout: 15000 });
}
async function downloadJson(page, selector) {
  const waiting = page.waitForEvent('download'); await page.locator(selector).filter({ visible: true }).first().click(); const download = await waiting;
  return { name: download.suggestedFilename(), value: JSON.parse(await readFile(await download.path(), 'utf8')) };
}
async function uploadJson(page, selector, value, name = 'qa-import.json') {
  await page.locator(selector).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await page.waitForFunction(selector => document.querySelector(selector)?.value === '', selector);
}
async function importCourse(page, value) {
  await uploadJson(page, '.course-file', value);
  const confirm = page.locator('[data-ce="course-replace-confirm"]');
  if (await confirm.count() && await confirm.isVisible()) await confirm.click();
}
async function panorama(page, name, color = '#234e70') {
  const data = await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 128, 512, 128);
    ctx.fillRect(40, 90, 32, 60); return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  await page.locator('.landscape-file').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  await page.waitForFunction(name => document.querySelector('.landscape-name')?.textContent.includes(name), name);
  await saved(page, '.landscape-save-status');
}
async function editField(page, selector, value) {
  await page.locator(selector).fill(value); await page.locator(selector).press('Tab');
}
async function newPage(target) {
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push({ url: target, message: error.message }));
  await page.goto(target); await ready(page);
  if (target.startsWith('http:')) {
    const actual = await page.evaluate(() => document.querySelector('meta[name="sky-build-id"]')?.content ?? null);
    if (report.webBuildId) assert.equal(actual, report.webBuildId, 'Every web context in one run must use the same build.');
    else report.webBuildId = actual;
  }
  return page;
}
async function visibleState(page) {
  return { title: await page.locator('.course-title').inputValue(), progress: await text(page, '.course-progress'),
    land: await text(page, '.landscape-name'), angle: await page.locator('.landscape-angle').inputValue(),
    enabled: await page.locator('.landscape-enabled').isChecked() };
}
async function userFlow({ channel, narrow, portable }) {
  browser = await chromium.launch({ channel, headless: true });
  context = await browser.newContext({ viewport: narrow ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  if (portable) await context.setOffline(true);
  const target = portable ? portableUrl : url, page = await newPage(target);
  const entry = { channel, browserVersion: browser.version(), narrow, portable, passed: [],
    buildId: await page.evaluate(() => document.querySelector('meta[name="sky-build-id"]')?.content ?? null) };
  report.cases.push(entry);
  await teaching(page);
  await editField(page, '.course-title', '持续课堂 QA');
  await editField(page, '.step-title', '地面观星');
  await editField(page, '.step-text', '从课堂保存并恢复观测场景。');
  await page.locator('[data-ce="record"]').click();
  await editField(page, '.step-title', '未录入步骤草稿');
  await editField(page, '.step-text', '下次继续讲解的内容');
  await editField(page, '.step-duration', '13'); await saved(page, '.course-save-status');
  await panorama(page, 'qa-campus.png');
  await editField(page, '.landscape-angle', '37');
  await page.locator('.landscape-enabled').uncheck(); await saved(page, '.landscape-save-status');
  await page.reload(); await ready(page); await teaching(page);
  assert.equal(await page.locator('.course-title').inputValue(), '持续课堂 QA');
  assert.equal(await page.locator('.step-title').inputValue(), '未录入步骤草稿');
  assert.equal(await page.locator('.step-text').inputValue(), '下次继续讲解的内容');
  assert.equal(await page.locator('.step-duration').inputValue(), '13');
  assert.match(await text(page, '.course-progress'), /0\/1/);
  assert.match(await text(page, '.landscape-name'), /qa-campus\.png/);
  assert.equal(await page.locator('.landscape-angle').inputValue(), '37');
  assert.equal(await page.locator('.landscape-enabled').isChecked(), false);
  entry.passed.push('course-step-and-unrecorded-draft-survive-reload', 'landscape-image-angle-disabled-survive-reload');

  await page.locator('.landscape-enabled').check(); await saved(page, '.landscape-save-status');
  await page.locator('.course-include-landscape').check();
  await saved(page, '.course-save-status');
  const bundle = await downloadJson(page, '[data-ce="export"]');
  assert.equal(bundle.value.format, 'sky-course-package'); assert.equal(bundle.value.version, 1);
  assert.equal(bundle.value.course.title, '持续课堂 QA'); assert.equal(bundle.value.course.steps.length, 1);
  assert.equal(bundle.value.landscape.name, 'qa-campus.png'); assert.equal(bundle.value.landscape.northOffsetDeg, 37);
  await writeFile(resolve(out, `${channel}-${narrow ? 'narrow' : portable ? 'portable' : 'desktop'}-course.json`), JSON.stringify(bundle.value, null, 2));
  entry.passed.push('actual-course-download-embeds-image-and-calibration');

  if (await page.locator('[data-ce="course-replace-cancel"]').count()) {
    const beforeReplacement = await visibleState(page);
    await uploadJson(page, '.course-file', { ...bundle.value, course: { ...bundle.value.course, title: '候选替换课程' } });
    await page.locator('.course-replace').waitFor({ state: 'visible' });
    assert.deepEqual(await visibleState(page), beforeReplacement);
    const backup = await downloadJson(page, '[data-ce="course-draft-export"]');
    assert.equal(backup.value.format, 'sky-course-draft');
    assert.equal(backup.value.draft.stepTitle, '未录入步骤草稿');
    await page.locator('[data-ce="course-replace-cancel"]').click();
    assert.deepEqual(await visibleState(page), beforeReplacement);
    entry.passed.push('replacement-requires-explicit-choice-and-cancel-preserves-draft', 'draft-backup-includes-unrecorded-editor-text');
  }

  await panorama(page, 'qa-home.png', '#705d23');
  await importCourse(page, bundle.value);
  await page.waitForFunction(() => /课程已载入/.test(document.querySelector('.ce-message')?.textContent ?? ''));
  await saved(page, '.course-save-status');
  assert.match(await text(page, '.landscape-name'), /qa-home\.png/);
  await page.locator('[data-view="space"]').click(); await ready(page);
  const beforeCourse = await page.evaluate(() => window.skyApp.state);
  await page.locator('[data-ce="next"]').click(); await ready(page);
  assert.equal(await page.evaluate(() => window.skyApp.state.viewMode), 'ground');
  assert.match(await text(page, '.landscape-name'), /qa-campus\.png/);
  await page.locator('[data-ce="exit"]').click(); await ready(page);
  assert.deepEqual(await page.evaluate(() => window.skyApp.state), beforeCourse);
  assert.match(await text(page, '.landscape-name'), /qa-home\.png/);
  entry.passed.push('bundle-import-and-course-entry-temporarily-apply-landscape', 'course-exit-restores-scene-and-personal-landscape');

  const beforeInvalid = await visibleState(page);
  await uploadJson(page, '.course-file', { ...bundle.value, landscape: { ...bundle.value.landscape, dataUrl: 'data:image/png;base64,broken' } }, 'invalid-bundle.json');
  await page.waitForFunction(() => /无法读取地景|地景包无效/.test(document.querySelector('.ce-message')?.textContent ?? ''));
  assert.deepEqual(await visibleState(page), beforeInvalid);
  await uploadJson(page, '.landscape-package', { version: 99, name: 'bad-landscape' });
  await page.waitForFunction(() => /无效|失败|错误|无法/.test(document.querySelector('.ce-message')?.textContent ?? ''));
  assert.deepEqual(await visibleState(page), beforeInvalid);
  await uploadJson(page, '.landscape-package', null, 'null-is-not-a-landscape.json');
  assert.deepEqual(await visibleState(page), beforeInvalid);
  const afterInvalidExport = await downloadJson(page, '[data-ce="export"]');
  const exportedCourse = afterInvalidExport.value.course ?? afterInvalidExport.value;
  assert.equal(exportedCourse.title, '持续课堂 QA'); assert.equal(exportedCourse.steps.length, 1);
  entry.passed.push('invalid-embedded-image-and-landscape-package-preserve-current-data');

  await page.locator('[data-ce="landscape-remove"]').click();
  await page.waitForFunction(() => document.querySelector('.landscape-name')?.textContent === '未载入地景');
  await saved(page, '.landscape-save-status');
  await page.locator('[data-ce="landscape-undo"]').click();
  await page.waitForFunction(() => document.querySelector('.landscape-name')?.textContent === 'qa-home.png');
  await saved(page, '.landscape-save-status');
  entry.passed.push('landscape-remove-is-persisted-and-undo-restores-image');

  await page.locator('.course-include-landscape').uncheck();
  await saved(page, '.course-save-status');
  const legacy = await downloadJson(page, '[data-ce="export"]');
  assert.equal(legacy.value.version, 1); assert.equal(legacy.value.title, '持续课堂 QA'); assert.equal(legacy.value.format, undefined);
  await importCourse(page, legacy.value); await saved(page, '.course-save-status');
  entry.passed.push('legacy-v1-course-round-trip-remains-supported');

  for (const mode of ['space', 'globe', 'horizon', 'ground']) {
    const button = page.locator(`[data-view="${mode}"]`); await button.focus(); await button.press('Enter'); await ready(page);
    assert.equal(await page.evaluate(() => window.skyApp.state.viewMode), mode);
  }
  await expand(page, '#sky-teaching');
  await page.locator('#sky-moon-loupe-toggle').click(); await page.locator('#sky-moon-loupe').waitFor({ state: 'visible' });
  await page.locator('#sky-moon-loupe-close').focus(); await page.locator('#sky-moon-loupe-close').press('Enter');
  await page.locator('#sky-moon-loupe').waitFor({ state: 'hidden' });
  await openPanel(page); await expand(page, '.offline-section');
  entry.versionText = await text(page, '#sky-app-version'); assert.ok(entry.versionText.trim().length > 0);
  if (portable) {
    assert.equal(await page.locator('#sky-check-update').isEnabled(), false);
    assert.match(await text(page, '#sky-offline-state'), /便携|文件|离线|检查/);
    entry.passed.push('portable-offline-startup-and-version-status');
  } else {
    await page.waitForFunction(() => window.skyApp.offlineStatus?.phase === 'ready', undefined, { timeout: 90000 });
    await page.locator('#sky-check-update').click();
    await page.waitForFunction(() => window.skyApp.offlineStatus?.updateCheck === 'current', undefined, { timeout: 30000 });
    entry.updateText = await text(page, '#sky-offline-state');
    await context.setOffline(true);
    server.select('/teaching/', 'final', 'sw.js');
    await page.locator('#sky-check-update').click();
    await page.waitForFunction(() => window.skyApp.offlineStatus?.updateCheck === 'failed', undefined, { timeout: 30000 });
    entry.offlineCheckText = await text(page, '#sky-offline-state');
    server.select('/teaching/', 'final');
    const navigation = await page.reload(); await ready(page); await teaching(page);
    assert.equal(navigation.fromServiceWorker(), true);
    assert.equal(await page.locator('.course-title').inputValue(), '持续课堂 QA');
    assert.match(await text(page, '.landscape-name'), /qa-home\.png/);
    entry.passed.push('manual-update-check-current-and-fetch-failure', 'service-worker-offline-reload-retains-teaching-data');
    await context.setOffline(false);
  }
  const horizontal = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(horizontal.documentWidth <= horizontal.width); entry.viewport = horizontal;
  entry.passed.push('native-keyboard-view-buttons-and-loupe-close', 'no-document-horizontal-overflow');
  await page.screenshot({ path: resolve(out, `${channel}-${narrow ? 'narrow' : portable ? 'portable' : 'desktop'}.png`) });

  if (channel === 'chrome' && !narrow && !portable) {
    const other = await newPage(target); await teaching(other);
    await editField(page, '.course-title', '主窗口已保存'); await saved(page, '.course-save-status');
    await editField(other, '.course-title', '旧窗口草稿');
    await other.waitForFunction(() => /其他页面|另一|冲突|已更新/.test(document.querySelector('.course-save-status')?.textContent ?? ''), undefined, { timeout: 15000 });
    assert.equal(await other.locator('.course-title').inputValue(), '旧窗口草稿');
    await page.reload(); await ready(page); await teaching(page);
    assert.equal(await page.locator('.course-title').inputValue(), '主窗口已保存');
    await other.locator('[data-ce="reload-saved"]').click();
    await other.waitForFunction(() => document.querySelector('.course-title')?.value === '主窗口已保存');
    entry.passed.push('stale-tab-conflict-does-not-overwrite-saved-draft-and-reload-recovers');
    await other.close();
  }
  await context.close(); context = null; await browser.close(); browser = null;
}
async function unavailableStorageRecovery() {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await newPage(url), entry = { scenario: 'temporary-indexeddb-denial-and-recovery', passed: [] };
  report.cases.push(entry); await teaching(page);
  await editField(page, '.course-title', '暂时拒绝存储前的课程');
  await page.locator('[data-ce="record"]').click(); await saved(page, '.course-save-status');
  await panorama(page, 'qa-recover.png');
  // Deliberate isolated browser fault: the real IDB implementation is preserved
  // and restored by this flag; only this application's teaching database fails.
  await context.addInitScript(() => {
    window.__qaDenyTeachingStorage = true;
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(name, ...args) {
      if (name === 'panoramic-night-sky-teaching' && window.__qaDenyTeachingStorage) throw new DOMException('QA temporary storage denial', 'SecurityError');
      return original.call(this, name, ...args);
    };
  });
  await page.reload(); await ready(page); await teaching(page);
  await page.waitForFunction(() => /无法使用本地保存/.test(document.querySelector('.course-save-status')?.textContent ?? '')
    && /无法使用本地保存/.test(document.querySelector('.landscape-save-status')?.textContent ?? ''));
  await page.evaluate(() => { window.__qaDenyTeachingStorage = false; });
  await page.locator('[data-ce="course-save-retry"]').click();
  await page.waitForFunction(() => document.querySelector('.course-title')?.value === '暂时拒绝存储前的课程');
  await page.locator('[data-ce="landscape-save-retry"]').click();
  await page.waitForFunction(() => document.querySelector('.landscape-name')?.textContent === 'qa-recover.png');
  entry.passed.push('retry-after-denied-hydration-restores-previous-course-and-image');
  await page.reload(); await ready(page); await teaching(page);
  await page.waitForFunction(() => /无法使用本地保存/.test(document.querySelector('.course-save-status')?.textContent ?? ''));
  await editField(page, '.course-title', '尚未见过旧稿时的新编辑');
  await page.waitForFunction(() => /无法使用本地保存/.test(document.querySelector('.course-save-status')?.textContent ?? ''));
  await page.evaluate(() => { window.__qaDenyTeachingStorage = false; });
  await page.locator('[data-ce="course-save-retry"]').click();
  await page.waitForFunction(() => /设备上已有保存内容/.test(document.querySelector('.course-save-status')?.textContent ?? ''));
  const backup = await downloadJson(page, '[data-ce="course-draft-export"]');
  assert.equal(backup.value.draft.course.title, '尚未见过旧稿时的新编辑');
  // Read the actual database only as a second oracle: visible recovery + export
  // have already exercised the product controls, and no records are modified.
  const persistedTitle = await page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('panoramic-night-sky-teaching', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('records'), record = transaction.objectStore('records').get('course-draft');
      record.onsuccess = () => resolve(record.result.value.course.title);
      record.onerror = () => reject(record.error); transaction.oncomplete = () => database.close();
    };
  }));
  assert.equal(persistedTitle, '暂时拒绝存储前的课程');
  entry.passed.push('editing-before-retry-preserves-new-edit-and-does-not-overwrite-unseen-saved-course');
  await page.screenshot({ path: resolve(out, 'storage-recovery-conflict.png') });
  await context.close(); context = null; await browser.close(); browser = null;
}
async function quotaTransactionRecovery() {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await newPage(url), entry = { scenario: 'quota-transaction-failure-and-retry', passed: [],
    fault: 'Isolated IDBObjectStore.put throws QuotaExceededError for course-draft; no disk is filled and no production hooks are used.' };
  report.cases.push(entry); await teaching(page);
  await editField(page, '.course-title', '配额失败前旧稿');
  await editField(page, '.step-text', '原有未录入讲解');
  await page.locator('[data-ce="record"]').click(); await saved(page, '.course-save-status');
  const readDraft = () => page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('panoramic-night-sky-teaching', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('records'), record = transaction.objectStore('records').get('course-draft');
      record.onsuccess = () => resolve(record.result); record.onerror = () => reject(record.error);
      transaction.oncomplete = () => database.close();
    };
  }));
  const originalRecord = await readDraft();
  await page.evaluate(() => {
    window.__qaOriginalTeachingPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'records' && key === 'course-draft') throw new DOMException('QA simulated storage quota', 'QuotaExceededError');
      return window.__qaOriginalTeachingPut.call(this, value, key);
    };
  });
  await editField(page, '.course-title', '配额不足仍保留的新草稿');
  await editField(page, '.step-text', '事务失败后仍需保留的未录入讲解');
  await page.waitForFunction(() => /存储空间不足/.test(document.querySelector('.course-save-status')?.textContent ?? ''));
  entry.failureMessage = await text(page, '.course-save-status');
  assert.doesNotMatch(entry.failureMessage, /已保存/);
  assert.equal(await page.locator('.course-title').inputValue(), '配额不足仍保留的新草稿');
  assert.equal(await page.locator('.step-text').inputValue(), '事务失败后仍需保留的未录入讲解');
  assert.deepEqual(await readDraft(), originalRecord);
  entry.passed.push('quota-error-is-visible-and-draft-remains-editable', 'aborted-transaction-preserves-exact-old-record-and-revision');
  const backup = await downloadJson(page, '[data-ce="course-draft-export"]');
  assert.equal(backup.value.draft.course.title, '配额不足仍保留的新草稿');
  assert.equal(backup.value.draft.stepText, '事务失败后仍需保留的未录入讲解');
  entry.passed.push('unsaved-quota-draft-can-still-be-exported');
  const dialogPromise = page.waitForEvent('dialog', { timeout: 10000 });
  const navigationAttempt = page.reload({ timeout: 10000 }).catch(error => error.message);
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss(); await navigationAttempt;
  assert.equal(await page.locator('.course-title').inputValue(), '配额不足仍保留的新草稿');
  assert.deepEqual(await readDraft(), originalRecord);
  entry.passed.push('native-beforeunload-warning-can-cancel-navigation-and-preserve-dirty-draft');
  await page.screenshot({ path: resolve(out, 'quota-unsaved-warning.png') });
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__qaOriginalTeachingPut; });
  await page.locator('[data-ce="course-save-retry"]').click(); await saved(page, '.course-save-status');
  const committed = await readDraft();
  assert.equal(committed.revision, originalRecord.revision + 1);
  assert.equal(committed.value.course.title, '配额不足仍保留的新草稿');
  assert.equal(committed.value.stepText, '事务失败后仍需保留的未录入讲解');
  await page.reload(); await ready(page); await teaching(page);
  assert.equal(await page.locator('.course-title').inputValue(), '配额不足仍保留的新草稿');
  assert.equal(await page.locator('.step-text').inputValue(), '事务失败后仍需保留的未录入讲解');
  assert.deepEqual(await readDraft(), committed);
  entry.passed.push('retry-after-restoring-storage-commits-once-and-exact-new-draft-survives-reload');
  entry.oldRevision = originalRecord.revision; entry.newRevision = committed.revision;
  await page.screenshot({ path: resolve(out, 'quota-recovered.png') });
  await context.close(); context = null; await browser.close(); browser = null;
}
try {
  const scenarios = [
    { channel: 'chrome', narrow: false, portable: false },
    { channel: 'chrome', narrow: true, portable: false },
    { channel: 'msedge', narrow: false, portable: false },
    { channel: 'chrome', narrow: false, portable: true },
  ];
  assert.ok(!process.env.SKY_QA_ONLY || process.env.SKY_QA_ONLY === 'quota', 'SKY_QA_ONLY supports only quota or the complete default suite.');
  if (process.env.SKY_QA_ONLY !== 'quota') {
    for (const scenario of scenarios) {
      console.log(`Running ${JSON.stringify(scenario)}`); await userFlow(scenario);
      await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
    }
    await unavailableStorageRecovery();
  }
  await quotaTransactionRecovery();
  assert.deepEqual(report.pageErrors, []); report.status = 'passed-teaching-resilience';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
  const page = context?.pages().find(page => !page.isClosed());
  if (page) {
    report.failureState = await page.evaluate(() => ({ offline: window.skyApp?.offlineStatus,
      courseStatus: document.querySelector('.course-save-status')?.textContent,
      landscapeStatus: document.querySelector('.landscape-save-status')?.textContent,
      message: document.querySelector('.ce-message')?.textContent })).catch(() => null);
    await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
  }
}
finally {
  await context?.close(); await browser?.close(); await server.close();
  report.finishedAt = new Date().toISOString(); report.allOwnedProcessesClosed = true;
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), cases: report.cases.length, failure: report.failure }));
}
