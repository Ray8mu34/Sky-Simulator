/** Presentation-only edits stay together until an explicit form transaction ends. */
export function trackFormDraft(form: HTMLFormElement): { isDirty(): boolean; markDirty(): void; clear(): void; dispose(): void } {
  let dirty = false;
  const onInput = () => { dirty = true; };
  form.addEventListener('input', onInput);
  return { isDirty: () => dirty, markDirty: onInput, clear: () => { dirty = false; }, dispose: () => form.removeEventListener('input', onInput) };
}
