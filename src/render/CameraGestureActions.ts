import type { SimulationState } from '../contracts';
import { EXTERNAL_CAMERA_LIMITS } from '../camera-limits';
const clamp=(value:number,minimum:number,maximum:number)=>Math.max(minimum,Math.min(maximum,value));
/** Pure-number camera adapter. It mutates only the currently active camera and returns whether it changed. */
export function applyCameraPan(state:SimulationState,dx:number,dy:number,viewportHeight:number):boolean {
  if(dx===0&&dy===0)return false;
  if(state.viewMode==='ground'){
    const camera=state.cameras.ground,scale=camera.verticalFovDeg/Math.max(1,viewportHeight),oldAz=camera.azimuthDegNorthEast,oldAlt=camera.altitudeDeg;
    camera.azimuthDegNorthEast=((oldAz-dx*scale)%360+360)%360;camera.altitudeDeg=clamp(oldAlt+dy*scale,-90,90);
    return oldAz!==camera.azimuthDegNorthEast||oldAlt!==camera.altitudeDeg;
  }
  const camera=state.cameras[state.viewMode],[x,y,z,w]=camera.orientationQuaternion;
  const sy=Math.sin(-dx*.002),cy=Math.cos(-dx*.002),sx=Math.sin(-dy*.002),cx=Math.cos(-dy*.002);
  // Global Y yaw × saved quaternion × local X pitch; same convention as desktop orbit.
  const ax=cy*x+sy*z,ay=cy*y+sy*w,az=cy*z-sy*x,aw=cy*w-sy*y;
  const result:[number,number,number,number]=[ax*cx+aw*sx,ay*cx+az*sx,az*cx-ay*sx,aw*cx-ax*sx];
  const length=Math.hypot(...result);camera.orientationQuaternion=result.map(value=>value/length) as typeof result;return true;
}
export function applyCameraZoom(state:SimulationState,scale:number):boolean {
  if(!(scale>0&&Number.isFinite(scale))||scale===1)return false;
  if(state.viewMode==='ground'){
    const camera=state.cameras.ground,previous=camera.verticalFovDeg;camera.verticalFovDeg=clamp(previous*scale,20,100);return previous!==camera.verticalFovDeg;
  }
  const camera=state.cameras[state.viewMode],limits=EXTERNAL_CAMERA_LIMITS[state.viewMode],previous=camera.distanceDisplayUnits;
  camera.distanceDisplayUnits=clamp(previous*scale,limits.minDistance,limits.maxDistance);return previous!==camera.distanceDisplayUnits;
}
