import type {RuntimeRenderQuality,RuntimeQualityCapabilities} from '../platform/runtime-quality-contract';

/** Pure display consumers only. Scheduling, thresholds and runtime history belong to main. */
export interface RuntimeLabelIdentity {id:string;selected?:boolean;qualityProtected?:boolean}
export function isProtectedRuntimeLabel(label:RuntimeLabelIdentity):boolean {
  return !!(label.selected||label.qualityProtected||label.id.startsWith('direction:')||label.id.startsWith('pole:')||label.id.startsWith('body:'));
}
export function runtimeLabelSecondary(label:RuntimeLabelIdentity,secondary:string|undefined,quality:Readonly<RuntimeRenderQuality>):string|undefined {
  return quality.hideOrdinarySecondaryLabels&&!isProtectedRuntimeLabel(label)?undefined:secondary;
}
export function runtimeLabelIsHiddenBack(label:RuntimeLabelIdentity,facing:number,finite:boolean,quality:Readonly<RuntimeRenderQuality>):boolean {
  return finite&&facing<=0&&quality.hideOrdinaryBackLabels&&!isProtectedRuntimeLabel(label);
}
export function runtimeOrdinaryLabelBudget(baseBudget:number,quality:Readonly<RuntimeRenderQuality>):number {
  return Math.max(0,Math.floor(baseBudget*Math.min(1,Math.max(0,quality.ordinaryLabelBudgetScale))));
}
export function sameRuntimeRenderQuality(a:Readonly<RuntimeRenderQuality>,b:Readonly<RuntimeRenderQuality>):boolean {
  return a.hideOrdinaryBackLabels===b.hideOrdinaryBackLabels&&a.hideOrdinarySecondaryLabels===b.hideOrdinarySecondaryLabels&&
    a.ordinaryLabelBudgetScale===b.ordinaryLabelBudgetScale&&a.reduceVerifiedDecoration===b.reduceVerifiedDecoration&&
    a.pixelScale===b.pixelScale&&a.omitOptionalInvisibleStars===b.omitOptionalInvisibleStars;
}
export const WEBGL_RUNTIME_QUALITY_CAPABILITIES:Readonly<RuntimeQualityCapabilities>=Object.freeze({
  removableLabels:true,verifiedDecorationReduction:false,pixelScaling:true,optionalInvisibleStars:false,
  unavailableReasons:Object.freeze({decoration:'当前装饰算法没有已验有效的简化档。',optionalStars:'当前目录没有独立的额外暗星包。'}),
});
