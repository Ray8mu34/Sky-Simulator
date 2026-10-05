import type { ViewMode } from '../contracts';

/** Runtime display overrides only: never serialized or used as science inputs. */
export interface RuntimeRenderQuality {
  readonly hideOrdinaryBackLabels: boolean;
  readonly hideOrdinarySecondaryLabels: boolean;
  readonly ordinaryLabelBudgetScale: number;
  readonly reduceVerifiedDecoration: boolean;
  readonly pixelScale: 1 | 0.85 | 0.70 | 0.55;
  readonly omitOptionalInvisibleStars: boolean;
}
export const DEFAULT_RUNTIME_RENDER_QUALITY: Readonly<RuntimeRenderQuality> = Object.freeze({
  hideOrdinaryBackLabels: false, hideOrdinarySecondaryLabels: false,
  ordinaryLabelBudgetScale: 1, reduceVerifiedDecoration: false, pixelScale: 1,
  omitOptionalInvisibleStars: false,
});
export interface RuntimeQualityCapabilities {
  readonly removableLabels: boolean;
  readonly verifiedDecorationReduction: boolean;
  readonly pixelScaling: boolean;
  readonly optionalInvisibleStars: boolean;
  readonly unavailableReasons?: Readonly<Partial<Record<'labels' | 'decoration' | 'pixels' | 'optionalStars', string>>>;
}
export const NO_RUNTIME_QUALITY_CAPABILITIES: Readonly<RuntimeQualityCapabilities> = Object.freeze({
  removableLabels: false, verifiedDecorationReduction: false, pixelScaling: false, optionalInvisibleStars: false,
});
export type QualityStage = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type QualityDeviceClass = 'desktop' | 'mobile';
/** Shared engineering budget class; viewport/coarse input does not identify a physical device. */
export function renderBudgetClass(width: number, height: number, coarsePointer: boolean): QualityDeviceClass {
  return width < 720 || (coarsePointer && height <= 600) ? 'mobile' : 'desktop';
}
export type QualityPressure = 'render' | 'compute' | 'unknown' | 'none';
export type QualityResetReason = 'pause' | 'hidden' | 'resume' | 'resize' | 'surface' | 'context' | 'view'
  | 'asset-warmup' | 'capture' | 'input' | 'transition' | 'science-error' | 'range-stop' | 'dispose';
export interface QualityWindow {
  readonly generation: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly eligibleActiveMs: number;
  readonly eligibleSamples: number;
  readonly rafP95Ms: number | null;
  readonly rendererSubmitP95Ms: number | null;
  readonly appWorkP95Ms: number | null;
  readonly pressure: QualityPressure;
}
export interface QualityChange {
  readonly atMs: number;
  readonly generation: number;
  readonly fromStage: QualityStage;
  readonly toStage: QualityStage;
  readonly reason: string;
  readonly skippedStages: readonly QualityStage[];
}
export interface QualityState {
  readonly stage: QualityStage;
  readonly generation: number;
  readonly badWindows: number;
  readonly goodWindows: number;
  readonly cooldownUntilMs: number;
  readonly settleUntilMs: number;
  readonly lastWindowEndMs: number | null;
  readonly history: readonly QualityChange[];
}
export interface QualityConfig {
  readonly deviceClass: QualityDeviceClass;
  readonly windowMs: number;
  readonly minEligibleActiveMs: number;
  readonly minEligibleSamples: number;
  readonly badRafP95Ms: number;
  readonly goodRafP95Ms: number;
  readonly badRendererSubmitP95Ms: number;
  readonly goodRendererSubmitP95Ms: number;
  readonly badWindowsRequired: number;
  readonly goodWindowsRequired: number;
  readonly cooldownMs: number;
  readonly settleMs: number;
  readonly maxHistory: number;
}
export const QUALITY_CONFIGS: Readonly<Record<QualityDeviceClass, Readonly<QualityConfig>>> = Object.freeze({
  desktop: Object.freeze({ deviceClass: 'desktop', windowMs: 2000, minEligibleActiveMs: 1500,
    minEligibleSamples: 8, badRafP95Ms: 22, goodRafP95Ms: 19,
    badRendererSubmitP95Ms: 6.6, goodRendererSubmitP95Ms: 5.4,
    badWindowsRequired: 3, goodWindowsRequired: 6, cooldownMs: 15000, settleMs: 1000, maxHistory: 32 }),
  mobile: Object.freeze({ deviceClass: 'mobile', windowMs: 2000, minEligibleActiveMs: 1500,
    minEligibleSamples: 8, badRafP95Ms: 40.37, goodRafP95Ms: 34.865,
    badRendererSubmitP95Ms: 11, goodRendererSubmitP95Ms: 9,
    badWindowsRequired: 3, goodWindowsRequired: 6, cooldownMs: 15000, settleMs: 1000, maxHistory: 32 }),
});
export type QualityEvent = { readonly kind: 'window'; readonly window: QualityWindow }
  | { readonly kind: 'reset'; readonly generation: number; readonly nowMs: number; readonly reason: QualityResetReason };
export interface QualityAdvanceResult {
  readonly state: QualityState;
  readonly changed: boolean;
  readonly effects: Readonly<RuntimeRenderQuality>;
  readonly reason: string;
  readonly skippedStages: readonly QualityStage[];
}

/** UI's pure helper owns one latest ticket and one handle; main alone touches DOM/WAAPI. */
export interface ViewTransitionTicket { readonly generation: number; readonly target: ViewMode }
export type ViewTransitionCancelReason = 'latest' | 'reduced-motion' | 'hidden' | 'pagehide' | 'dispose' | 'resize'
  | 'surface' | 'context' | 'import' | 'reset' | 'capture' | 'focus' | 'reference-lock' | 'science-error' | 'range-stop';
export interface ViewTransitionHandle { readonly finished: Promise<void>; cancel(): void }
export interface ViewTransitionAdapter {
  /** Called on request: guards stage input; the previous paired picture stays visible. */
  prepare(ticket: ViewTransitionTicket): void;
  /** After real paired target render, fade this sole canvas from 0 to 1 before the RAF paints. */
  animate(ticket: ViewTransitionTicket, durationMs: number): ViewTransitionHandle;
  /** Idempotently restores opacity/input and releases adapter resources. */
  settle(): void;
}
export interface ViewTransitionDiagnostics {
  readonly phase: 'idle' | 'waiting-render' | 'animating' | 'disposed';
  readonly ticket: ViewTransitionTicket | null;
  readonly reducedMotion: boolean;
  readonly handleCount: 0 | 1;
  readonly lastCancelReason: ViewTransitionCancelReason | null;
}
export interface ViewTransitionController {
  request(ticket: ViewTransitionTicket): void;
  onPairedRender(ticket: ViewTransitionTicket): void;
  cancel(reason: ViewTransitionCancelReason): void;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
  readonly diagnostics: ViewTransitionDiagnostics;
}
