import type { SimulationState } from '../contracts';
import { parseState } from '../state';

export interface SceneSummary { id: string; name: string; updatedAt: number }
interface SavedScene extends SceneSummary { state: SimulationState }
interface Envelope { schemaVersion: 1; scenes: SavedScene[] }
export type SceneLibraryErrorCode = 'unavailable' | 'corrupt' | 'quota' | 'limit' | 'invalid-name' | 'not-found' | 'invalid-state';
export class SceneLibraryError extends Error {
  constructor(readonly code: SceneLibraryErrorCode, message: string) { super(message); this.name = 'SceneLibraryError'; }
}
export interface SceneStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface SceneLibrary {
  list(): SceneSummary[];
  save(name: string, state: unknown, id?: string): SceneSummary;
  load(id: string): SimulationState;
  remove(id: string): void;
}
export const SCENE_LIBRARY_KEY = 'panoramic-night-sky:scene-library:v1';
export const SCENE_LIBRARY_LIMITS = { maxEntries: 20, maxNameCharacters: 80, maxBytes: 256 * 1024 } as const;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const summary = ({ id, name, updatedAt }: SavedScene): SceneSummary => ({ id, name, updatedAt });
function validName(name: unknown): name is string {
  return typeof name === 'string' && !!name.trim() && Array.from(name.trim()).length <= SCENE_LIBRARY_LIMITS.maxNameCharacters;
}
function newSceneId(existing: readonly SavedScene[]): string {
  const ids = new Set(existing.map(scene => scene.id));
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      const id = globalThis.crypto.randomUUID();
      if (!ids.has(id)) return id;
    }
  } catch { /* IDs identify local records, never security tokens. */ }
  const base = `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  // Twenty existing records imply at least one of these 21 distinct suffixes is unused.
  for (let suffix = 0; suffix <= SCENE_LIBRARY_LIMITS.maxEntries; suffix++) {
    const id = `${base}-${suffix}`;
    if (!ids.has(id)) return id;
  }
  throw new SceneLibraryError('unavailable', '无法生成场景记录标识；原有场景未被修改。');
}
/** One JSON commit, independent of SW caches. Reads stay fresh; no uncommitted in-memory saved state. */
export function createSceneLibrary(injectedStorage?: SceneStorage,
  limits: { maxEntries?: number; maxBytes?: number } = {}): SceneLibrary {
  const maxEntries = Math.min(SCENE_LIBRARY_LIMITS.maxEntries, limits.maxEntries ?? SCENE_LIBRARY_LIMITS.maxEntries);
  const maxBytes = Math.min(SCENE_LIBRARY_LIMITS.maxBytes, limits.maxBytes ?? SCENE_LIBRARY_LIMITS.maxBytes);
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('场景库上限必须是正整数。');
  const storage = (): SceneStorage => {
    try { return injectedStorage ?? globalThis.localStorage; }
    catch { throw new SceneLibraryError('unavailable', '浏览器拒绝本地存储；仍可导出场景 JSON。'); }
  };
  const read = (): Envelope => {
    let text: string | null;
    try { text = storage().getItem(SCENE_LIBRARY_KEY); }
    catch { throw new SceneLibraryError('unavailable', '无法读取本地场景库；已保存的数据未被修改。'); }
    if (text === null) return { schemaVersion: 1, scenes: [] };
    try {
      if (bytes(text) > maxBytes) throw new Error('容量超限');
      const raw = JSON.parse(text) as Envelope;
      if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.scenes) || raw.scenes.length > maxEntries
        || Object.keys(raw).some(key => !['schemaVersion', 'scenes'].includes(key))) throw new Error('格式不支持');
      const ids = new Set<string>();
      const scenes = raw.scenes.map(scene => {
        if (!scene || typeof scene.id !== 'string' || !scene.id || scene.id.length > 80 || ids.has(scene.id)
          || !validName(scene.name) || !Number.isFinite(scene.updatedAt) || scene.updatedAt < 0
          || Object.keys(scene).some(key => !['id', 'name', 'updatedAt', 'state'].includes(key))) throw new Error('记录不完整');
        ids.add(scene.id);
        return { id: scene.id, name: scene.name.trim(), updatedAt: scene.updatedAt, state: parseState(scene.state) };
      });
      return { schemaVersion: 1, scenes };
    } catch { throw new SceneLibraryError('corrupt', '本地场景库损坏或版本不支持；原始数据已保留，未自动清空。'); }
  };
  const write = (envelope: Envelope): void => {
    if (envelope.scenes.length > maxEntries) throw new SceneLibraryError('limit', `最多保存 ${maxEntries} 个场景；请先删除不再需要的场景。`);
    const text = JSON.stringify(envelope);
    if (bytes(text) > maxBytes) throw new SceneLibraryError('limit', '本地场景库超过 256 KiB 总容量；请先删除不再需要的场景。');
    try { storage().setItem(SCENE_LIBRARY_KEY, text); }
    catch (error) {
      const quota = error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError';
      throw new SceneLibraryError(quota ? 'quota' : 'unavailable', quota ? '浏览器存储配额不足；原有场景未被修改。' : '浏览器拒绝保存场景；原有场景未被修改。');
    }
  };
  return {
    list() { return read().scenes.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(summary); },
    save(name, incoming, id) {
      if (!validName(name)) throw new SceneLibraryError('invalid-name', '场景名称须为非空文字，最多 80 个字符。');
      let state: SimulationState;
      try { state = parseState(incoming); }
      catch (error) { throw new SceneLibraryError('invalid-state', error instanceof Error ? error.message : '场景数据无效。'); }
      const envelope = read(), index = id === undefined ? -1 : envelope.scenes.findIndex(scene => scene.id === id);
      if (id !== undefined && index < 0) throw new SceneLibraryError('not-found', '未找到要更新的场景。');
      const next: SavedScene = { id: id ?? newSceneId(envelope.scenes), name: name.trim(), updatedAt: Date.now(), state };
      if (index < 0) envelope.scenes.push(next); else envelope.scenes[index] = next;
      write(envelope); return summary(next);
    },
    load(id) {
      const scene = read().scenes.find(entry => entry.id === id);
      if (!scene) throw new SceneLibraryError('not-found', '未找到该保存场景。');
      return parseState(scene.state);
    },
    remove(id) {
      const envelope = read(), index = envelope.scenes.findIndex(scene => scene.id === id);
      if (index < 0) throw new SceneLibraryError('not-found', '未找到要删除的场景。');
      envelope.scenes.splice(index, 1); write(envelope);
    },
  };
}
/** Lazy storage access keeps unavailable/file-origin storage from breaking app startup. */
export const sceneLibrary = createSceneLibrary();
