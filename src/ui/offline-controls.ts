import type { OfflineController, OfflineStatus } from '../platform/offline-status';

/** Presents the platform's one lifecycle; never activates a worker or reloads a lesson. */
export function mountOfflineControls(section: HTMLElement, notice: HTMLElement, openSceneLibrary: () => void) {
  section.innerHTML = `<summary>版本与离线</summary>
    <p id="sky-app-version" class="offline-version"></p>
    <button id="sky-check-update" type="button" aria-describedby="sky-offline-state" disabled>检查更新</button>
    <p id="sky-offline-state" class="tiny-note" role="status" aria-live="polite">正在确认版本…</p>
    <details class="offline-build-details"><summary>版本详情</summary><dl></dl></details>`;
  notice.innerHTML = `<p id="sky-offline-notice-text" role="status" aria-live="polite"></p>
    <div class="offline-notice-actions"><button id="sky-offline-save" type="button">前往保存场景</button><button id="sky-offline-retry" type="button">重试检查</button></div>`;
  notice.setAttribute('aria-label', '版本与离线提示');
  const query = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const check = query<HTMLButtonElement>('#sky-check-update');
  const inline = query<HTMLElement>('#sky-offline-state');
  const save = notice.querySelector<HTMLButtonElement>('#sky-offline-save')!;
  const retry = notice.querySelector<HTMLButtonElement>('#sky-offline-retry')!;
  const noticeText = notice.querySelector<HTMLElement>('#sky-offline-notice-text')!;
  const version = document.querySelector<HTMLMetaElement>('meta[name="sky-version"]')?.content;
  let controller: OfflineController | null = null, status: OfflineStatus | null = null, disposed = false;
  let signature = '';
  const checkNow = () => { if (controller && !check.disabled) void controller.checkForUpdate(); };
  check.addEventListener('click', checkNow);
  retry.addEventListener('click', checkNow);
  save.addEventListener('click', openSceneLibrary);
  function render() {
    if (!status || disposed) return;
    const nextSignature = `${JSON.stringify(status)}:${Boolean(controller)}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    const { phase, expectedBuildId, activeBuildId, waitingBuildId } = status;
    const humanVersion = version ? `v${version}` : phase === 'development' ? '本地开发' : phase === 'portable' ? '离线版' : '版本待确认';
    query('#sky-app-version').textContent = `当前版本 ${humanVersion}${expectedBuildId ? ` · ${expectedBuildId.slice(0, 8)}` : ''}`;
    const busy = status.updateCheck === 'checking' || phase === 'installing';
    check.disabled = !controller || !status.canCheckForUpdate || busy;
    check.setAttribute('aria-busy', String(busy));
    check.textContent = status.updateCheck === 'checking' ? '正在检查…' : phase === 'installing' ? '正在准备…' : '检查更新';
    retry.disabled = check.disabled;
    retry.setAttribute('aria-busy', String(busy));
    const needsAttention = ['update-ready', 'update-failed', 'error'].includes(phase);
    const hint = phase === 'portable' ? '可直接离线打开。更新时请下载新的离线版。' : phase === 'development' ? '本地开发环境不检查线上更新。' : status.message;
    inline.textContent = hint;
    inline.dataset.phase = phase;
    // The persistent notice announces actionable conditions once; inline copy stays readable.
    inline.setAttribute('aria-live', needsAttention ? 'off' : 'polite');
    noticeText.textContent = needsAttention ? status.message : '';
    notice.dataset.phase = phase;
    notice.hidden = !needsAttention;
    save.hidden = phase !== 'update-ready';
    retry.hidden = phase === 'update-ready' || !status.canCheckForUpdate;
    const list = query<HTMLDListElement>('.offline-build-details dl');
    list.replaceChildren();
    const rows: Array<[string, string | null]> = [['本页版本', expectedBuildId], ['离线版本', activeBuildId], ['待启用版本', waitingBuildId]];
    for (const [label, value] of rows) {
      if (!value) continue;
      const term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label; description.textContent = value; list.append(term, description);
    }
    query<HTMLDetailsElement>('.offline-build-details').hidden = !list.childElementCount;
    window.dispatchEvent(new CustomEvent('sky:layout-change'));
  }
  return {
    update(value: OfflineStatus) { status = value; render(); },
    setController(value: OfflineController) { controller = value; render(); },
    dispose() {
      disposed = true;
      check.removeEventListener('click', checkNow); retry.removeEventListener('click', checkNow);
      save.removeEventListener('click', openSceneLibrary);
    },
  };
}
