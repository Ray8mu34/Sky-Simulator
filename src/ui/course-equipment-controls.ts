import type { SimulationState, ScienceSnapshot } from '../contracts';
import { applyState, createDefaultState, serializeState } from '../state';
import { COURSE_PACKAGE_MAX_BYTES, parseCourse, parseCourseDraft, parseCoursePackage } from '../core/course';
import type { Course, CourseDraft } from '../core/course';
import { defaultInstrument, instrumentField, validateInstrument } from '../core/instruments';
import { applyPreparedLandscape, captureLandscape, landscapeSaveStatus, landscapeState, prepareLandscape,
  restoreLandscape, retryLandscapeSave, updateLandscape } from '../platform/landscape';
import type { PreparedLandscape } from '../platform/landscape';
import { LANDSCAPE_MAX_BYTES, parseLandscape } from '../platform/landscape-data';
import { createLocalDraft, teachingStorage } from '../platform/teaching-storage';
import type { LocalSaveStatus } from '../platform/teaching-storage';

export function mountCourseEquipment(parent: HTMLElement, state: SimulationState, onChange: (reason: string) => void) {
  const root = document.createElement('details'); root.className = 'control-section course-equipment';
  // Static product markup only; all imported titles, narration and filenames use textContent/value.
  root.innerHTML = `<summary>课程 / 设备与地景</summary>
    <details class="course-tools"><summary>课程演示</summary>
      <label>课程标题<input class="course-title" aria-label="课程标题" value="我的天文课" maxlength="120"></label>
      <label>步骤标题<input class="step-title" aria-label="步骤标题" placeholder="步骤标题" maxlength="120"></label>
      <label>步骤讲解<textarea class="step-text" aria-label="步骤讲解" placeholder="步骤讲解" maxlength="4000" style="resize: none" rows="4"></textarea></label>
      <label>停留秒数<input class="step-duration" type="number" value="8" min="2" max="600" aria-describedby="course-input-error"></label>
      <div class="event-grid"><button data-ce="record">记录当前场景</button><button data-ce="demo">载入示例课程</button><button data-ce="previous">上一步</button><button data-ce="next">下一步</button><button data-ce="play">自动播放</button><button data-ce="pause">暂停课程</button><button data-ce="exit">退出并恢复</button><button data-ce="export">导出课程</button></div>
      <label><input class="course-include-landscape" type="checkbox">课程携带地景</label>
      <button data-ce="course-landscape">采用当前地景</button><p class="course-landscape-name tiny-note"></p>
      <label>导入课程或草稿 JSON<input class="course-file" type="file" accept="application/json,.json"></label>
      <div class="course-replace" hidden><p class="course-replace-message tiny-note" role="status"></p><div class="event-grid"><button data-ce="course-draft-export">备份当前草稿</button><button data-ce="course-replace-cancel">保留当前</button><button data-ce="course-replace-confirm">替换当前草稿</button></div></div>
      <p class="tiny-note">课程最多 100 步、2 MB；含地景的课程包最多 14 MB。</p>
      <p class="course-save-status tiny-note" role="status" aria-live="polite" style="min-height: 2.8em"></p>
      <div class="event-grid"><button data-ce="course-draft-export">备份草稿</button><button data-ce="course-save-retry">重试保存课程</button></div>
      <p class="tiny-note">草稿自动保存在此设备；清除网站数据会删除本地保存。备份文件可在其他设备导入。</p>
      <p class="course-progress tiny-note" role="status"></p><p class="course-narration"></p>
    </details>
    <details class="equipment-tools"><summary>相机与目镜</summary><p class="tiny-note">三维地表视图使用；视场框中心是当前视线。</p>
      <label>模式<select data-instrument="mode"><option value="off">关闭</option><option value="camera">相机取景框</option><option value="eyepiece">目镜视场</option></select></label>
      ${[['focalLengthMm','镜头/望远镜焦距 mm'],['sensorWidthMm','传感器宽 mm'],['sensorHeightMm','传感器高 mm'],['eyepieceMm','目镜焦距 mm'],['apparentFovDeg','目镜表观视场 °'],['rotationDeg','取景框旋转 °']].map(([key,label]) => `<label>${label}<input type="number" step="any" data-instrument="${key}"></label>`).join('')}
      <div class="event-grid"><button data-ce="instrument">应用设备</button><button data-ce="fit">适配视场</button><button data-ce="wide">恢复广角</button></div><p class="instrument-readout tiny-note"></p><p class="tiny-note">目镜真视场采用表观视场÷倍率近似。可在“星空显示 · 光污染”中显示至10等，补充寻星与构图参考星。</p>
    </details>
    <details class="landscape-tools"><summary>自定义全景地景</summary>
      <p class="tiny-note">导入 2:1 等距柱状 PNG/WebP，最大 8 MB、8192×4096，天空区域透明。图像左边缘为北、中央为南；中线为地平。仅三维地表显示，不改变升落计算。</p>
      <label>选择全景图片<input class="landscape-file" type="file" accept="image/png,image/webp"></label>
      <label><input class="landscape-enabled" type="checkbox">显示自定义地景</label>
      <label>方位校准 °<input class="landscape-angle" type="number" min="-360" max="360" value="0" aria-describedby="course-input-error"></label>
      <div class="event-grid"><button data-ce="landscape-export">导出地景包</button><button data-ce="landscape-remove">移除地景</button></div>
      <button data-ce="landscape-undo" hidden>撤销移除地景</button>
      <label>导入地景包（最大 12 MB）<input class="landscape-package" type="file" accept="application/json,.json"></label>
      <p class="landscape-name tiny-note"></p><p class="landscape-save-status tiny-note" role="status" aria-live="polite" style="min-height: 2.8em"></p>
      <button data-ce="landscape-save-retry">重试保存地景</button>
    </details>
    <button data-ce="reload-saved" hidden>重新读取已保存内容</button><p id="course-input-error" class="ce-message tiny-note" role="status"></p>`;
  parent.append(root);
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const blankLandscape = (): PreparedLandscape => ({ current: null, pixels: null });
  let course: Course = { version: 1, title: '我的天文课', steps: [] }, index = -1;
  let courseLandscape = blankLandscape(), restore: SimulationState | null = null, restoreLand = blankLandscape();
  let playing = false, ready = false, elapsed = 0, last = 0, expected = '', disposed = false, internal = false;
  let timer: ReturnType<typeof setInterval> | null = null, saveTimer: ReturnType<typeof setTimeout> | null = null;
  let courseIntent = 0, landscapeIntent = 0, draftPending = false, composing = false, restoreError = false;
  let courseLoaded = false, landscapeLoaded = false;
  let pendingReplacement: { value: CourseDraft; landscape: PreparedLandscape } | null = null;
  let removedLandscape: PreparedLandscape | null = null;
  const message = (text: string) => { q('.ce-message').textContent = text; };
  const saveStatus = (selector: string, status: LocalSaveStatus, noun: string) => {
    const el = q(selector);
    el.textContent = status.phase === 'loading' ? `正在读取${noun}…` : status.phase === 'empty' ? `${noun}会自动保存在此设备。`
      : status.phase === 'saving' ? `正在保存${noun}…` : status.phase === 'saved' ? `${noun}已保存在此设备。` : status.error?.message ?? '未保存，请导出备份。';
    el.classList.toggle('is-error', status.phase === 'error');
  };
  const draft = createLocalDraft<CourseDraft>(teachingStorage, 'course-draft', parseCourseDraft, status => {
    if (disposed) return;
    if (!draftPending) saveStatus('.course-save-status', status, '课程草稿');
    q<HTMLButtonElement>('[data-ce="course-save-retry"]').disabled = !courseLoaded || status.phase !== 'error';
    syncReload();
  });
  function syncReload() {
    q<HTMLButtonElement>('[data-ce="reload-saved"]').hidden = ![draft.status(), landscapeSaveStatus()].some(s => s.phase === 'error') && !restoreError;
  }
  const download = (data: string, name: string) => {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function getDraft(): CourseDraft {
    return parseCourseDraft({ version: 1, course: { ...course, title: q<HTMLInputElement>('.course-title').value },
      landscape: courseLandscape.current, includeLandscape: q<HTMLInputElement>('.course-include-landscape').checked,
      stepTitle: q<HTMLInputElement>('.step-title').value, stepText: q<HTMLTextAreaElement>('.step-text').value,
      stepDuration: q<HTMLInputElement>('.step-duration').value });
  }
  function saveDraft() {
    if (saveTimer) clearTimeout(saveTimer); saveTimer = null;
    if (composing || disposed) return;
    try { const value = getDraft(); draftPending = false; void draft.save(value); }
    catch { draftPending = true; message('草稿尚未保存，请检查标题与讲解长度并备份。'); }
  }
  function changedDraft(immediate = false) {
    courseIntent++; draftPending = true;
    if (saveTimer) clearTimeout(saveTimer);
    q('.course-save-status').textContent = '课程草稿有未保存的编辑…';
    if (immediate && !composing) saveDraft();
    else if (!composing) saveTimer = setTimeout(saveDraft, 300);
  }
  function stop() { playing = false; if (timer) clearInterval(timer); timer = null; }
  function show() {
    q('.course-progress').textContent = `${q<HTMLInputElement>('.course-title').value} · ${index >= 0 ? index + 1 : 0}/${course.steps.length} · ${playing ? '自动播放' : restore ? '已暂停' : '未开始'}`;
    q('.course-narration').textContent = index >= 0 ? `${course.steps[index]?.title ?? ''}\n${course.steps[index]?.text ?? ''}` : '';
    q('.course-landscape-name').textContent = courseLandscape.current ? `课程地景：${courseLandscape.current.name}` : '课程使用演示开始时的地景。';
  }
  function exitCourse() {
    stop();
    if (restore) {
      internal = true; applyState(state, restore); applyPreparedLandscape(restoreLand, false); onChange('import'); internal = false;
    }
    restore = null; index = -1; show();
  }
  function step(next: number) {
    if (next < 0 || next >= course.steps.length) { stop(); show(); return; }
    landscapeIntent++;
    if (!restore) { restore = structuredClone(state); restoreLand = captureLandscape(); applyPreparedLandscape(restoreLand, false); }
    index = next; internal = true;
    if (courseLandscape.current && q<HTMLInputElement>('.course-include-landscape').checked) applyPreparedLandscape(courseLandscape, false);
    applyState(state, course.steps[index]!.scene); state.time.running = false; onChange('import'); internal = false;
    expected = serializeState(state); ready = false; elapsed = 0; last = performance.now(); show();
  }
  function tick() {
    const now = performance.now(); if (!document.hidden && ready) elapsed += (now - last) / 1000; last = now;
    if (playing && index >= 0 && elapsed >= course.steps[index]!.durationSeconds) step(index + 1);
  }
  const notify = () => { if (!internal && playing) { stop(); show(); message('手动操作已暂停课程。'); } };
  const stage = document.querySelector('#sky-stage');
  stage?.addEventListener('pointerdown', notify); stage?.addEventListener('wheel', notify); stage?.addEventListener('keydown', notify);
  function sync() {
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-ce="next"],[data-ce="previous"],[data-ce="play"]')) button.disabled = !courseLoaded || !landscapeLoaded;
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.landscape-tools input,.landscape-tools button')) control.disabled = !landscapeLoaded;
    const instrument = state.instrument ?? defaultInstrument;
    for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-instrument]')) {
      if (document.activeElement !== el) el.value = String(instrument[el.dataset.instrument as keyof typeof instrument]);
    }
    const field = instrumentField(instrument);
    q('.instrument-readout').textContent = `相机 ${field.widthDeg.toFixed(2)}° × ${field.heightDeg.toFixed(2)}°；目镜 ${field.magnification.toFixed(1)}× / ${field.trueFovDeg.toFixed(2)}°`;
    const land = landscapeState().current;
    q<HTMLInputElement>('.landscape-enabled').checked = !!land?.enabled;
    q<HTMLInputElement>('.landscape-enabled').disabled = !land || !landscapeLoaded;
    q<HTMLInputElement>('.landscape-angle').disabled = !land || !landscapeLoaded;
    q<HTMLButtonElement>('[data-ce="landscape-remove"]').disabled = !land || !landscapeLoaded;
    q<HTMLButtonElement>('[data-ce="landscape-export"]').disabled = !land || !landscapeLoaded;
    q<HTMLButtonElement>('[data-ce="landscape-save-retry"]').disabled = !landscapeLoaded || landscapeSaveStatus().phase !== 'error';
    q('.landscape-name').textContent = land?.name ?? '未载入地景';
    if (document.activeElement !== q('.landscape-angle')) q<HTMLInputElement>('.landscape-angle').value = String(land?.northOffsetDeg ?? 0);
  }
  function setCourseReady(ready: boolean) {
    courseLoaded = ready;
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('.course-tools input,.course-tools textarea,.course-tools button')) control.disabled = !ready;
    q<HTMLButtonElement>('[data-ce="course-save-retry"]').disabled = !ready || draft.status().phase !== 'error';
    sync();
  }
  function attachLandscape() {
    const land = captureLandscape(); if (!land.current) throw new Error('先导入要随课程携带的地景。');
    courseLandscape = land; q<HTMLInputElement>('.course-include-landscape').checked = true; changedDraft(true); show();
  }
  function requestReplacement(value: CourseDraft, landscape: PreparedLandscape) {
    const current = getDraft();
    const hasWork = current.course.steps.length > 0 || current.course.title !== '我的天文课' || current.stepTitle !== ''
      || current.stepText !== '' || current.stepDuration !== '8' || current.landscape !== null;
    if (!hasWork) { replaceDraft(value, landscape); return; }
    pendingReplacement = { value, landscape };
    q('.course-replace').hidden = false;
    q('.course-replace-message').textContent = `载入“${value.course.title || '未命名课程'}”会替换当前课程和未录入的编辑。可先备份当前草稿。`;
    q<HTMLButtonElement>('[data-ce="course-replace-cancel"]').focus();
  }
  function replaceDraft(value: CourseDraft, landscape: PreparedLandscape) {
    draft.allowReplacement(); applyDraft(value, landscape); changedDraft(true);
    pendingReplacement = null; q('.course-replace').hidden = true;
    message('课程已载入，选择下一步或自动播放开始。');
  }
  const click = async (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-ce]'), action = button?.dataset.ce;
    if (!action || button?.disabled) return;
    try {
      message('');
      if (['record','demo','next','previous','play','pause','exit'].includes(action)) courseIntent++;
      if (action === 'record') {
        const duration = q<HTMLInputElement>('.step-duration');
        const valid = Number.isFinite(duration.valueAsNumber) && duration.valueAsNumber >= 2 && duration.valueAsNumber <= 600;
        duration.setAttribute('aria-invalid', String(!valid));
        if (!valid) { duration.focus(); throw new Error('停留秒数应为 2–600 秒。'); }
        const scene = structuredClone(state); scene.time.running = false;
        const next = parseCourse({ version: 1, title: q<HTMLInputElement>('.course-title').value, steps: [...course.steps,
          { title: q<HTMLInputElement>('.step-title').value || `步骤 ${course.steps.length + 1}`, text: q<HTMLTextAreaElement>('.step-text').value, durationSeconds: duration.valueAsNumber, scene }] });
        stop(); course = next; changedDraft(true); show();
      }
      if (action === 'demo') {
        const base = createDefaultState();
        const example = parseCourse({ version: 1, title: '从地面到天球', steps: ['ground','space','globe','horizon'].map((viewMode, i) => ({
          title: ['地面观星','地球与星空','天球坐标','当地地平'][i], text: ['从观测者位置看星体升落。','从外部比较地球和背景星空。','用天赤道与黄道理解天球坐标。','比较天顶、地平与天极。'][i],
          durationSeconds: 8, scene: { ...base, viewMode, layers: { ...base.layers, celestialEquator: true, ecliptic: true, celestialPoles: true } } })) });
        requestReplacement({ version: 1, course: example, landscape: null, includeLandscape: false,
          stepTitle: '', stepText: '', stepDuration: '8' }, blankLandscape());
      }
      if (action === 'course-replace-cancel') { pendingReplacement = null; q('.course-replace').hidden = true; q<HTMLInputElement>('.course-title').focus(); }
      if (action === 'course-replace-confirm' && pendingReplacement) {
        const pending = pendingReplacement; replaceDraft(pending.value, pending.landscape); q<HTMLInputElement>('.course-title').focus();
      }
      if (action === 'next') step(index + 1); if (action === 'previous') step(index - 1);
      if (action === 'play') {
        if (!course.steps.length) throw new Error('先记录步骤或载入示例课程。');
        stop(); if (index < 0 || index === course.steps.length - 1) step(0);
        playing = true; last = performance.now(); timer = setInterval(tick, 100); show();
      }
      if (action === 'pause') { stop(); show(); }
      if (action === 'exit') exitCourse();
      if (action === 'course-landscape') attachLandscape();
      if (action === 'export') {
        const value = parseCourse({ ...course, title: q<HTMLInputElement>('.course-title').value });
        const include = q<HTMLInputElement>('.course-include-landscape').checked && courseLandscape.current;
        const data = include ? { format: 'sky-course-package', version: 1, course: value, landscape: courseLandscape.current } : value;
        const json = JSON.stringify(data, null, 2); parseCoursePackage(json);
        download(json, include ? 'sky-course-package.json' : 'sky-course.json');
      }
      if (action === 'course-draft-export') download(JSON.stringify({ format: 'sky-course-draft', version: 1, draft: getDraft() }, null, 2), 'sky-course-draft.json');
      if (action === 'course-save-retry') {
        if (draftPending) saveDraft(); setCourseReady(false);
        try {
          const token = courseIntent, restored = await draft.retry();
          if (restored && !disposed && token === courseIntent) {
            try {
              const land = await prepareLandscape(restored.landscape);
              if (!disposed && token === courseIntent) { applyDraft(restored, land); q('.course-save-status').textContent = '已恢复此设备的课程草稿，尚未开始演示。'; }
            } catch { if (!disposed && token === courseIntent) draft.rejectLoadedValue('课程地景无法读取，原草稿已保留；请重新导入备份。'); }
          }
        } finally { if (!disposed) setCourseReady(true); }
      }
      if (action === 'landscape-save-retry') {
        landscapeIntent++; exitCourse(); landscapeLoaded = false; sync();
        try { await retryLandscapeSave(); } finally { landscapeLoaded = true; if (!disposed) sync(); }
      }
      if (action === 'reload-saved') window.location.reload();
      if (action === 'instrument' || action === 'fit') {
        const value = { ...defaultInstrument };
        for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-instrument]')) (value as unknown as Record<string, unknown>)[el.dataset.instrument!] = el.dataset.instrument === 'mode' ? el.value : Number(el.value);
        validateInstrument(value); state.instrument = value;
        if (action === 'fit') { state.viewMode = 'ground'; const f = instrumentField(value); state.cameras.ground.verticalFovDeg = Math.max(.05, Math.min(100, (value.mode === 'eyepiece' ? f.trueFovDeg : Math.hypot(f.widthDeg, f.heightDeg)) * 1.4)); }
        onChange('view'); sync();
      }
      if (action === 'wide') { state.cameras.ground.verticalFovDeg = 65; state.instrument = { ...(state.instrument ?? defaultInstrument), mode: 'off' }; onChange('view'); sync(); }
      if (action === 'landscape-export') { const land = landscapeState().current; if (!land) throw new Error('先导入地景。'); download(JSON.stringify(land), 'sky-landscape.json'); }
      if (action === 'landscape-remove') {
        landscapeIntent++; exitCourse(); removedLandscape = captureLandscape(); applyPreparedLandscape(blankLandscape());
        q('[data-ce="landscape-undo"]').hidden = false; message('地景已移除；离开页面前可撤销。'); sync();
      }
      if (action === 'landscape-undo' && removedLandscape) {
        landscapeIntent++; exitCourse(); applyPreparedLandscape(removedLandscape); removedLandscape = null;
        q('[data-ce="landscape-undo"]').hidden = true; sync();
      }
    } catch (error) { message(error instanceof Error ? error.message : '操作未完成，请检查输入后重试。'); }
  };
  function applyDraft(value: CourseDraft, landscape: PreparedLandscape) {
    exitCourse(); course = value.course; courseLandscape = landscape;
    q<HTMLInputElement>('.course-title').value = course.title;
    q<HTMLInputElement>('.step-title').value = value.stepTitle; q<HTMLTextAreaElement>('.step-text').value = value.stepText;
    q<HTMLInputElement>('.step-duration').value = value.stepDuration; q<HTMLInputElement>('.course-include-landscape').checked = value.includeLandscape;
    show();
  }
  const change = async (event: Event) => {
    const el = event.target as HTMLInputElement;
    const isCourse = el.matches('.course-file'), isLandscape = el.matches('.landscape-file,.landscape-package');
    const token = isCourse ? ++courseIntent : isLandscape ? ++landscapeIntent : 0;
    try {
      if (isCourse) {
        const file = el.files?.[0]; if (!file) return;
        pendingReplacement = null; q('.course-replace').hidden = true;
        if (file.size > COURSE_PACKAGE_MAX_BYTES) throw new Error('课程包最大 14 MB。');
        const text = await file.text(); if (disposed || token !== courseIntent) return;
        let raw: unknown; try { raw = JSON.parse(text); } catch { throw new Error('无法读取课程 JSON，请重新选择有效文件。'); }
        let value: CourseDraft;
        if (raw && typeof raw === 'object' && 'format' in raw && raw.format === 'sky-course-draft') {
          if (!('version' in raw) || raw.version !== 1 || !('draft' in raw)) throw new Error('不支持此草稿版本。');
          value = parseCourseDraft(raw.draft);
        } else {
          const pack = parseCoursePackage(text);
          value = { version: 1, course: pack.course, landscape: pack.landscape, includeLandscape: !!pack.landscape, stepTitle: '', stepText: '', stepDuration: '8' };
        }
        const land = await prepareLandscape(value.landscape); if (disposed || token !== courseIntent) return;
        requestReplacement(value, land);
      }
      if (isLandscape) {
        const file = el.files?.[0]; if (!file) return;
        if (file.size > (el.matches('.landscape-file') ? 8_000_000 : LANDSCAPE_MAX_BYTES)) throw new Error(el.matches('.landscape-file') ? '图片最大 8 MB。' : '地景包最大 12 MB。');
        let value;
        if (el.matches('.landscape-file')) {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取图片，请重新选择。')); reader.readAsDataURL(file); });
          value = { version: 1 as const, name: file.name, dataUrl, northOffsetDeg: 0, enabled: true };
        } else {
          try { value = JSON.parse(await file.text()); } catch { throw new Error('无法读取地景 JSON，请重新选择有效文件。'); }
        }
        if (disposed || token !== landscapeIntent) return;
        const prepared = await prepareLandscape(parseLandscape(value)); if (disposed || token !== landscapeIntent) return;
        exitCourse(); applyPreparedLandscape(prepared); removedLandscape = null; q('[data-ce="landscape-undo"]').hidden = true; sync(); message('地景已载入。');
      }
      if (el.matches('.course-include-landscape')) {
        if (el.checked) { try { attachLandscape(); } catch (error) { el.checked = false; throw error; } }
        else { courseLandscape = blankLandscape(); changedDraft(true); show(); }
      }
      if (el.matches('.landscape-enabled')) { landscapeIntent++; const enabled = el.checked; exitCourse(); updateLandscape({ enabled }); sync(); }
      if (el.matches('.landscape-angle')) {
        const angle = el.valueAsNumber, valid = Number.isFinite(angle) && Math.abs(angle) <= 360;
        el.setAttribute('aria-invalid', String(!valid)); if (!valid) throw new Error('方位校准应为 −360 至 360°。');
        landscapeIntent++; exitCourse(); updateLandscape({ northOffsetDeg: angle }); sync();
      }
    } catch (error) {
      if ((isCourse && token !== courseIntent) || (isLandscape && token !== landscapeIntent) || disposed) return;
      message(error instanceof Error ? error.message : '导入未完成，原有内容已保留。');
    } finally { if (el.type === 'file') el.value = ''; }
  };
  const draftFields = '.course-title,.step-title,.step-text,.step-duration';
  const input = (event: Event) => {
    if (!(event.target as Element).matches(draftFields)) return;
    changedDraft(); if (!composing) show();
  };
  const compositionStart = (event: Event) => { if ((event.target as Element).matches(draftFields)) { composing = true; changedDraft(); } };
  const compositionEnd = (event: Event) => { if ((event.target as Element).matches(draftFields)) { composing = false; changedDraft(); show(); } };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (draftPending || draft.status().dirty || landscapeSaveStatus().dirty) { event.preventDefault(); event.returnValue = ''; }
  };
  const landChange = () => { onChange('layers'); sync(); };
  const landSaved = () => {
    const status = landscapeSaveStatus(); saveStatus('.landscape-save-status', status, '地景');
    q<HTMLButtonElement>('[data-ce="landscape-save-retry"]').disabled = !landscapeLoaded || status.phase !== 'error'; syncReload();
  };
  const landRestoreError = () => { restoreError = true; q('.landscape-save-status').textContent = '已保存地景无法读取，原记录已保留；请重新导入图片。'; q('.landscape-save-status').classList.add('is-error'); syncReload(); };
  root.addEventListener('click', click); root.addEventListener('change', change); root.addEventListener('input', input);
  root.addEventListener('compositionstart', compositionStart); root.addEventListener('compositionend', compositionEnd);
  window.addEventListener('sky:landscape', landChange); window.addEventListener('sky:landscape-save', landSaved);
  window.addEventListener('sky:landscape-restore-error', landRestoreError); window.addEventListener('beforeunload', beforeUnload);
  sync(); show(); saveStatus('.course-save-status', draft.status(), '课程草稿'); landSaved();
  setCourseReady(false);
  void restoreLandscape().finally(() => { landscapeLoaded = true; if (!disposed) sync(); });
  const loadIntent = courseIntent;
  void draft.load().then(async value => {
    if (!value || disposed || loadIntent !== courseIntent) return;
    try {
      const land = await prepareLandscape(value.landscape);
      if (disposed || loadIntent !== courseIntent) return;
      applyDraft(value, land); q('.course-save-status').textContent = '已恢复此设备的课程草稿，尚未开始演示。';
    } catch { if (!disposed && loadIntent === courseIntent) { draft.rejectLoadedValue('课程地景无法读取，原草稿已保留；请重新导入备份。'); restoreError = true; syncReload(); } }
  }).finally(() => {
    if (!disposed) setCourseReady(true);
  });
  return {
    notify,
    update(snapshot: ScienceSnapshot) {
      if (restore && !internal) { if (serializeState(state) !== expected && playing) { stop(); show(); } if (snapshot.utDaysJ2000 === state.time.utDaysJ2000) ready = true; }
      sync();
    },
    dispose() {
      if (draftPending && !composing) saveDraft(); disposed = true; stop(); if (saveTimer) clearTimeout(saveTimer);
      root.removeEventListener('click', click); root.removeEventListener('change', change); root.removeEventListener('input', input);
      root.removeEventListener('compositionstart', compositionStart); root.removeEventListener('compositionend', compositionEnd);
      window.removeEventListener('sky:landscape', landChange); window.removeEventListener('sky:landscape-save', landSaved);
      window.removeEventListener('sky:landscape-restore-error', landRestoreError); window.removeEventListener('beforeunload', beforeUnload);
      stage?.removeEventListener('pointerdown', notify); stage?.removeEventListener('wheel', notify); stage?.removeEventListener('keydown', notify); root.remove();
    },
  };
}
