import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { createFinalSceneManifest, deriveFinalSceneTimes, getFinalSceneExecutionPlan, inspectFinalPortableArtifact, isFinalSceneInteractionReady, portableResourceAllowed, scientificSnapshotFields, PRIORITY_SCENE_IDS, REMAINING_SCENE_IDS } from '../scripts/qa-final-scenes';
import type { FinalSceneInteractionInput } from '../scripts/qa-final-scenes';
import { dateToUt, parseCivilInput } from '../src/core/time';
import { serializeState } from '../src/state';
import { computeSnapshot } from '../src/core/astronomy';

test('remaining13 exactly complement the original12: all25/76 retained and43 remaining assertions have executable/open plans', () => {
  const all = createFinalSceneManifest(), remaining = createFinalSceneManifest(REMAINING_SCENE_IDS);
  assert.equal(new Set([...PRIORITY_SCENE_IDS, ...REMAINING_SCENE_IDS]).size, 25);
  assert.deepEqual([...PRIORITY_SCENE_IDS, ...REMAINING_SCENE_IDS].sort(), all.scenes.map(scene => scene.id).sort());
  assert.equal(remaining.scenes.length, 13);
  assert.equal(remaining.scenes.reduce((sum, scene) => sum + scene.source.assertions.length, 0), 43);
  assert.equal(all.source.assertionCount, 76);
  for (const scene of remaining.scenes) {
    assert.ok(scene.source.assertions.every(assertion => assertion.status === 'not-run'));
    for (const part of ['cpu', 'native', 'oracle', 'record', 'open'] as const) assert.ok(scene.executionPlan[part].length > 30, `${scene.id}:${part}`);
  }
  assert.match(getFinalSceneExecutionPlan('P01').open, /30min.*not-executed/);
  assert.match(getFinalSceneExecutionPlan('O02').open, /Android\/iOS.*external-unverified/);
  const changed = getFinalSceneExecutionPlan('O02'); changed.native = 'mutated';
  assert.notEqual(getFinalSceneExecutionPlan('O02').native, changed.native);
});

test('solar selector derives four fixed descending setup instants without changing original complete state/selector', () => {
  const scene = createFinalSceneManifest(['S08']).scenes[0]!, before = serializeState(scene.state), sourceBefore = JSON.stringify(scene.source);
  const setup = deriveFinalSceneTimes(scene);
  assert.equal(setup.kind, 'actual-core-derived-geometric-solar-altitudes'); assert.equal(setup.complete, true);
  const events = setup.events as { targetGeometricAltitudeDeg: number; utDaysJ2000: number; utc: string; residualDeg: number; branch: string }[];
  assert.deepEqual(events.map(event => event.targetGeometricAltitudeDeg), [0, -6, -12, -18]);
  const seed = dateToUt(new Date('2026-09-14T00:00:00Z'));
  for (const [i, event] of events.entries()) {
    assert.equal(event.branch, 'first-descending-after-seed'); assert.ok(event.utDaysJ2000 > seed && event.utDaysJ2000 < seed + 1);
    assert.ok(Math.abs(event.residualDeg) < .00005); assert.ok(Math.abs(dateToUt(new Date(event.utc)) - event.utDaysJ2000) * 86400 <= .00051);
    if (i) assert.ok(event.utDaysJ2000 > events[i - 1]!.utDaysJ2000);
  }
  assert.equal(serializeState(scene.state), before); assert.equal(JSON.stringify(scene.source), sourceBefore);
  assert.match(setup.scope, /setup|QA setup/); assert.match(setup.scope, /not.*independent/);
});

test('lunar selector keeps original seed and allfour independent fixed USNO rows; derived inputs remain separate from goldens', () => {
  const scene = createFinalSceneManifest(['S09']).scenes[0]!, before = serializeState(scene.state);
  const setup = deriveFinalSceneTimes(scene);
  const raw = readFileSync('tests/fixtures/usno-phase-2026-09-web-capture.json'), metadata = JSON.parse(readFileSync('tests/fixtures/usno-phase-2026-09-web-capture.metadata.json', 'utf8'));
  assert.equal(createHash('sha256').update(raw).digest('hex'), metadata.sha256);
  const reference = JSON.parse(raw.toString('utf8'));
  assert.equal(setup.complete, true); assert.equal(setup.seedUtDaysJ2000, dateToUt(new Date('2026-09-01T00:00:00Z')));
  const events = setup.events as { phaseLongitudeDeg: number; utDaysJ2000: number }[];
  assert.deepEqual(events.map(event => event.phaseLongitudeDeg), [270, 0, 90, 180]);
  for (const [i, event] of events.entries()) {
    const row = reference.phasedata[i], [hour, minute] = row.time.split(':').map(Number);
    const expected = parseCivilInput({ astronomicalYear: row.year, month: row.month, day: row.day, hour, minute, second: 0, zone: { kind: 'fixed', offsetMinutes: 0 }, ambiguousTime: 'reject' });
    assert.ok(Math.abs(event.utDaysJ2000 - expected) * 86400 <= 120);
  }
  assert.equal(serializeState(scene.state), before); assert.match(setup.scope, /setup inputs.*Independent USNO/);
});

test('portable request oracle excludes neighbouringfiles and HTTP even when offline requestsfail', () => {
  const document = 'file:///D:/qa/%E5%A4%9C%E7%A9%BA.html';
  for (const allowed of [document, `${document}?worker=off`, 'blob:null/123', 'data:image/png;base64,aGVsbG8=']) assert.equal(portableResourceAllowed(allowed, document), true);
  for (const external of ['file:///D:/qa/texture.png', 'file:///D:/other/%E5%A4%9C%E7%A9%BA.html', 'https://cdn.example.org/a.js', 'http://127.0.0.1:4173/a.js']) assert.equal(portableResourceAllowed(external, document), false);
});

test('a paired target is not gesture-ready until the transition is idle and actual stage input is restored', () => {
  const app: FinalSceneInteractionInput = { ready: true, state: { time: { running: false, utDaysJ2000: 9752 }, viewMode: 'space', selected: 'body:Moon' },
    snapshot: { utDaysJ2000: 9752 }, diagnostics: { scienceDirty: false, pendingInteractionCount: 0, lastRenderedUt: 9752,
      lastRenderedMode: 'space', lastRenderedSelection: 'body:Moon', viewTransition: { phase: 'idle', ticket: null, handleCount: 0 } },
    rendererDiagnostics: { stageInputEnabled: true } };
  assert.equal(isFinalSceneInteractionReady(app), true);
  assert.equal(runInNewContext(`(${isFinalSceneInteractionReady.toString()})()`, { skyApp: app }), true, 'Browser-serialised predicate must have no module closure');
  for (const phase of ['waiting-render', 'animating', 'disposed']) {
    const changed = structuredClone(app); changed.diagnostics.viewTransition!.phase = phase; assert.equal(isFinalSceneInteractionReady(changed), false);
  }
  const blocked = structuredClone(app); blocked.rendererDiagnostics!.stageInputEnabled = false; assert.equal(isFinalSceneInteractionReady(blocked), false);
  const handle = structuredClone(app); handle.diagnostics.viewTransition!.handleCount = 1; assert.equal(isFinalSceneInteractionReady(handle), false);
  const ticket = structuredClone(app); ticket.diagnostics.viewTransition!.ticket = { target: 'space' }; assert.equal(isFinalSceneInteractionReady(ticket), false);
  const absent = structuredClone(app); absent.diagnostics.viewTransition = null; assert.equal(isFinalSceneInteractionReady(absent), false);
  const stale = structuredClone(app); stale.diagnostics.lastRenderedUt = 9751; assert.equal(isFinalSceneInteractionReady(stale), false);
  const playing = structuredClone(app); playing.state.time.running = true; assert.equal(isFinalSceneInteractionReady(playing), false);
});

test('portable identity uses actual bytes+independent pinned SHA/report, and permits its real lack of Web build meta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sky-final-portable-identity-')), path = join(dir, 'example.html'), buildReportPath = join(dir, 'build-report.json');
  const content = Buffer.from('<!doctype html><html><head><meta name="theme-color" content="#020407"></head><body><script>void 0;</script></body></html>');
  const digest = createHash('sha256').update(content).digest('hex'), report = { format: 'classic-iife', bytes: content.length, sha256: digest, builtAt: '2026-10-05T00:00:00Z' };
  writeFileSync(path, content); writeFileSync(buildReportPath, JSON.stringify(report));
  try {
    const identity = inspectFinalPortableArtifact({ path, buildReportPath, expectedSha256: digest });
    assert.equal(identity.sha256, digest); assert.equal(identity.htmlBuildMeta, null); assert.equal(identity.bytes, content.length);
    assert.match(identity.scope, /Web meta.*separate.*not an equality oracle/);
    assert.throws(() => inspectFinalPortableArtifact({ path, buildReportPath, expectedSha256: 'f'.repeat(64) }), /Unexpected frozen portable/);
    writeFileSync(buildReportPath, JSON.stringify({ ...report, sha256: '0'.repeat(64) })); assert.throws(() => inspectFinalPortableArtifact({ path, buildReportPath }), /hash differs/);
    writeFileSync(buildReportPath, JSON.stringify({ ...report, bytes: report.bytes + 1 })); assert.throws(() => inspectFinalPortableArtifact({ path, buildReportPath }), /size differs/);
    writeFileSync(buildReportPath, JSON.stringify({ ...report, format: 'esm' })); assert.throws(() => inspectFinalPortableArtifact({ path, buildReportPath }), /Unexpected portable format/);
  } finally { unlinkSync(path); unlinkSync(buildReportPath); rmdirSync(dir); }
});

test('scientific snapshot comparison excludes only transport requestId and keeps every scientific field', () => {
  const state = createFinalSceneManifest(['S14']).scenes[0]!.state, first = computeSnapshot(state, 3029), next = computeSnapshot(state, 3030);
  assert.notDeepEqual(first, next); assert.deepEqual(scientificSnapshotFields(first), scientificSnapshotFields(next));
  assert.equal(first.requestId, 3029); assert.equal(next.requestId, 3030);
  assert.deepEqual(Object.keys(scientificSnapshotFields(first)).sort(), Object.keys(first).filter(key => key !== 'requestId').sort());
  const changed = structuredClone(next); changed.utDaysJ2000 += .001;
  assert.notDeepEqual(scientificSnapshotFields(first), scientificSnapshotFields(changed));
  const changedWarning = structuredClone(next); changedWarning.warnings = [...changedWarning.warnings, 'Different scientific policy'];
  assert.notDeepEqual(scientificSnapshotFields(first), scientificSnapshotFields(changedWarning));
});
