import type { ExternalCamera, LayerState, ObjectId, RuntimeMetrics, ScienceSnapshot, SimulationState, ViewMode } from '../contracts';
import type { SkyAppearance } from '../core/sky-appearance';
import type { RuntimeQualityCapabilities, RuntimeRenderQuality } from './runtime-quality-contract';

export type GraphicsKind = 'webgl2' | 'canvas2d';
export type GraphicsContextState = 'lost' | 'restored';
export type GraphicsReason = 'webgl2-ready' | 'webgl2-unavailable' | 'context-lost' | 'retry-failed' | 'restore-failed';
export interface GraphicsCapabilities {
  /** 2D is a fixed observer sky overview; serialized view/cameras remain unchanged. */
  observerOverview: boolean;
  cameraInteraction: boolean;
  referenceLock: boolean;
  moonLoupe: boolean;
  supportedViews: readonly ViewMode[];
  unsupportedLayers: readonly (keyof LayerState)[];
}
export interface GraphicsStatus {
  kind: GraphicsKind;
  available: boolean;
  reason: GraphicsReason;
  message: string;
  retry3dAvailable: boolean;
  contextLost: boolean;
  capabilities: GraphicsCapabilities;
}
export interface RendererAssetStatus { pending: string[]; loaded: string[]; errors: string[] }
export interface MoonLoupeStatus {
  status: 'pending' | 'ready' | 'error';
  errorMessage?: string | null;
  magnificationRelativeToMain?: number | null;
}
/** One active renderer consumes the existing canonical state and paired science snapshot. */
export interface RendererPort {
  readonly canvas: HTMLCanvasElement;
  render(state: SimulationState, snapshot: ScienceSnapshot, appearance?: SkyAppearance): void;
  resize(): void;
  dispose(): void;
  capture(appearance?: SkyAppearance): string;
  focusSelection(state: SimulationState, snapshot: ScienceSnapshot): boolean;
  changeReferenceLock(state: SimulationState, snapshot: ScienceSnapshot, previousLock: ExternalCamera['referenceLock']): void;
  getMetrics(): Partial<RuntimeMetrics>;
  getAssetStatus(): RendererAssetStatus;
  getInteractionDiagnostics(): unknown;
  getSkyAppearanceDiagnostics(): unknown;
  getMoonLoupeDiagnostics(): MoonLoupeStatus | null;
  setMoonLoupeViewport(rect: DOMRect | null): void;
  setRuntimeQuality(quality: Readonly<RuntimeRenderQuality>): void;
  getRuntimeQualityCapabilities(): Readonly<RuntimeQualityCapabilities>;
  setStageInputEnabled(enabled: boolean): void;
  resetPointerGestures?(): void;
}
export type RendererFactory = (container: HTMLElement, onInvalidate: () => void, onSelect: (id: ObjectId | null) => void,
  onContextState?: (state: GraphicsContextState) => void) => RendererPort;

export const WEBGL_CAPABILITIES: GraphicsCapabilities = {
  observerOverview: false, cameraInteraction: true, referenceLock: true, moonLoupe: true,
  supportedViews: ['ground', 'space', 'globe', 'horizon'], unsupportedLayers: [],
};
export const CANVAS_CAPABILITIES: GraphicsCapabilities = {
  observerOverview: true, cameraInteraction: false, referenceLock: false, moonLoupe: false,
  supportedViews: [], unsupportedLayers: ['milkyWay', 'ecliptic', 'celestialEquator', 'celestialPoles', 'horizon', 'meridian',
    'terrain', 'earthDay', 'earthNightLights', 'earthClouds', 'backHemisphere'],
};
