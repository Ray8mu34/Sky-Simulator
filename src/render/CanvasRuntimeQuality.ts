import type { RuntimeQualityCapabilities, RuntimeRenderQuality } from '../platform/runtime-quality-contract';

/** Display consumers only. The main-owned controller decides whether/when to change these values. */
export const CANVAS_RUNTIME_QUALITY_CAPABILITIES: Readonly<RuntimeQualityCapabilities> = Object.freeze({
  removableLabels: true, verifiedDecorationReduction: false, pixelScaling: true, optionalInvisibleStars: false,
  unavailableReasons: Object.freeze({ decoration: '二维全天图没有已验有效的装饰简化档。', optionalStars: '当前目录没有独立的额外暗星包。' }),
});

/** Main raster may shrink; the existing label/HUD overlay keeps the original capped density. CSS coordinates stay unchanged. */
export function canvasRuntimeRaster(width: number, height: number, basePixelRatio: number, pixelScale: RuntimeRenderQuality['pixelScale']) {
  if (![width, height, basePixelRatio].every(Number.isFinite) || width < 1 || height < 1 || basePixelRatio <= 0
    || ![1, .85, .70, .55].includes(pixelScale)) throw new RangeError('Canvas运行像素尺寸、基准像素比和档位必须有效。');
  const mainPixelRatio = basePixelRatio * pixelScale;
  return { basePixelRatio, mainPixelRatio, labelPixelRatio: basePixelRatio,
    mainWidth: Math.max(1, Math.floor(width * mainPixelRatio)), mainHeight: Math.max(1, Math.floor(height * mainPixelRatio)),
    baseWidth: Math.max(1, Math.floor(width * basePixelRatio)), baseHeight: Math.max(1, Math.floor(height * basePixelRatio)),
    labelWidth: Math.max(1, Math.round(width * basePixelRatio)), labelHeight: Math.max(1, Math.round(height * basePixelRatio)) };
}
