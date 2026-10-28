/** Static supplementary copy only. Consequences and errors must remain inline. */
export function infoTip(id: string, label: string, content: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return `<span class="info-tip"><button type="button" class="info-tip-trigger" aria-label="${escape(label)}" aria-describedby="${escape(id)}" aria-controls="${escape(id)}" aria-expanded="false"><span aria-hidden="true">ⓘ</span></button><span id="${escape(id)}" class="info-tip-content" role="tooltip" popover="manual">${escape(content)}</span></span>`;
}

/** One controller for hover, keyboard and touch; the top layer avoids panel clipping. */
export function mountInfoTips(root: HTMLElement): () => void {
  let active: HTMLButtonElement | null = null;
  let pinned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const removers: Array<() => void> = [];
  const tipFor = (button: HTMLButtonElement) => document.getElementById(button.getAttribute('aria-controls')!)!;
  const cancelClose = () => { if (timer) clearTimeout(timer); timer = undefined; };
  function close() {
    cancelClose();
    if (active) { tipFor(active).hidePopover(); active.setAttribute('aria-expanded', 'false'); }
    active = null; pinned = false;
  }
  function position() {
    if (!active) return;
    const button = active, tip = tipFor(button);
    const anchor = button.getBoundingClientRect(), box = tip.getBoundingClientRect();
    const scroller = button.closest('.panel-scroll')?.getBoundingClientRect();
    if (!anchor.width || (scroller && (anchor.bottom <= scroller.top || anchor.top >= scroller.bottom))) { close(); return; }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const compact = root.querySelector('.controls-compact')?.getBoundingClientRect();
    const bottom = compact?.height && compact.top > anchor.top ? Math.min(top + height - 8, compact.top - 6) : top + height - 8;
    tip.style.left = `${Math.max(left + 8, Math.min(anchor.left, left + width - box.width - 8))}px`;
    const below = anchor.bottom + 6;
    tip.style.top = `${Math.max(top + 8, Math.min(below + box.height <= bottom ? below : anchor.top - box.height - 6, bottom - box.height))}px`;
  }
  function open(button: HTMLButtonElement) {
    cancelClose();
    if (active === button) return;
    close(); active = button;
    tipFor(button).showPopover(); button.setAttribute('aria-expanded', 'true');
    position();
  }
  function leave() {
    cancelClose();
    if (!pinned && document.activeElement !== active) timer = setTimeout(close, 160);
  }
  function listen(target: EventTarget, type: string, handler: EventListener, capture = false) {
    target.addEventListener(type, handler, capture);
    removers.push(() => target.removeEventListener(type, handler, capture));
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('.info-tip-trigger')) {
    const tip = tipFor(button);
    listen(button, 'pointerenter', event => { if ((event as PointerEvent).pointerType !== 'touch') open(button); });
    listen(button, 'pointerleave', leave);
    listen(button, 'focus', () => open(button));
    listen(button, 'blur', close);
    listen(button, 'click', () => { if (active === button && pinned) close(); else { open(button); pinned = true; } });
    listen(tip, 'pointerenter', cancelClose);
    listen(tip, 'pointerleave', leave);
  }
  listen(document, 'pointerdown', event => {
    if (active && !active.contains(event.target as Node) && !tipFor(active).contains(event.target as Node)) close();
  }, true);
  listen(document, 'keydown', event => {
    if (active && (event as KeyboardEvent).key === 'Escape') { close(); event.preventDefault(); event.stopPropagation(); }
  }, true);
  listen(root, 'scroll', event => { if (active && event.target !== tipFor(active)) position(); }, true);
  listen(root, 'toggle', event => { if (event.target instanceof HTMLDetailsElement && !event.target.open) close(); }, true);
  listen(window, 'resize', close);
  if (window.visualViewport) { listen(window.visualViewport, 'resize', close); listen(window.visualViewport, 'scroll', close); }
  return () => { close(); removers.forEach(remove => remove()); };
}
