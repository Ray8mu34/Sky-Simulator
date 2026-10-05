import * as THREE from 'three';
import type { RefractionProfile } from '../core/refraction';

/** One owned RG32F slot; CPU/profile identity and GPU arithmetic errors are separate. */
export class RefractionGpuBridge {
  readonly texture = new THREE.DataTexture(new Float32Array(8192),4096,1,THREE.RGFormat,THREE.FloatType);
  readonly uniforms = {
    uRefractionLut:{value:this.texture},uRefractionEnabled:{value:false},
    uRefractionForward:{value:new THREE.Vector4(-1,90,4095/91,0)},
    uRefractionInverseLow:{value:new THREE.Vector4(-1,5,0,2047/6)},
    uRefractionInverseHigh:{value:new THREE.Vector4(5,90,2047,2048/85)},
  };
  private uploadedKey:string|null=null;
  private uploadGeneration=0;
  private uploadedMaximumCorrectionDeg=0;
  private profile:RefractionProfile|null=null;
  constructor(){
    this.texture.colorSpace=THREE.NoColorSpace;this.texture.minFilter=this.texture.magFilter=THREE.NearestFilter;
    this.texture.generateMipmaps=false;this.texture.flipY=false;this.texture.internalFormat='RG32F';
    this.texture.userData.refractionLut=true;
  }
  update(profile:RefractionProfile):void {
    this.profile=profile;this.uniforms.uRefractionEnabled.value=!profile.identity;
    if(profile.identity)return;
    const l=profile.layout;
    this.uniforms.uRefractionForward.value.set(-1,90,l.forwardIndexPerDegree,l.lowSlope);
    this.uniforms.uRefractionInverseLow.value.set(l.apparentJoinDeg,l.apparentSplitDeg,0,l.inverseLowIndexPerDegree);
    this.uniforms.uRefractionInverseHigh.value.set(l.apparentSplitDeg,90,l.inverseSplitIndex,l.inverseHighIndexPerDegree);
    if(this.uploadedKey!==profile.key){
      (this.texture.image.data as Float32Array).set(profile.copyTextureData());
      this.uploadedMaximumCorrectionDeg=0;const data=this.texture.image.data as Float32Array;
      for(let i=0;i<data.length;i+=2)this.uploadedMaximumCorrectionDeg=Math.max(this.uploadedMaximumCorrectionDeg,data[i]!);
      this.texture.needsUpdate=true;this.uploadedKey=profile.key;this.uploadGeneration++;
    }
  }
  get maximumCorrectionDeg():number{return this.profile?.identity?0:this.uploadedMaximumCorrectionDeg;}
  getDiagnostics(){return {profileKey:this.profile?.key??null,profileVersion:this.profile?.profileVersion??null,
    descriptor:this.profile?.descriptor??null,identity:this.profile?.identity??true,enabled:this.uniforms.uRefractionEnabled.value,
    textureId:this.texture.uuid,textureDimensions:[4096,1],textureFormat:'RG32F',textureBytes:32768,
    residentTextureCount:1,uploadedKey:this.uploadedKey,uploadGeneration:this.uploadGeneration,
    forwardUniform:this.uniforms.uRefractionForward.value.toArray(),inverseLowUniform:this.uniforms.uRefractionInverseLow.value.toArray(),inverseHighUniform:this.uniforms.uRefractionInverseHigh.value.toArray(),
    layout:this.profile?.layout??null,errorScope:'CPU profile interpolation and actual GPU arithmetic are verified separately'};}
}
