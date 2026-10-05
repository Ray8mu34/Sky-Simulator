import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ExternalCamera, Mat3, ScienceSnapshot, SimulationState, Vec3 } from '../contracts';
import { EXTERNAL_CAMERA_LIMITS } from '../camera-limits';
import { EQJ_TO_THREE, horizontalFrame, multiplyMatrix, multiplyVector, transpose } from './coordinates';

export type ReferenceLock = ExternalCamera['referenceLock'];
export function cameraFrameForLock(snapshot: ScienceSnapshot, lock: ReferenceLock): Mat3 {
  if (lock === 'local-horizon') return horizontalFrame(snapshot.eqjToHorizontalGeometric);
  if (lock === 'earth-fixed') return multiplyMatrix(EQJ_TO_THREE, transpose(snapshot.earthFixedToEqj));
  return EQJ_TO_THREE;
}
export function cameraFrameForState(state: SimulationState, snapshot: ScienceSnapshot): Mat3 {
  return state.viewMode === 'ground' ? horizontalFrame(snapshot.eqjToHorizontalGeometric) : cameraFrameForLock(snapshot, state.cameras[state.viewMode].referenceLock);
}
function rotationMatrix(m: Mat3): Matrix4 { return new Matrix4().set(...m[0], 0, ...m[1], 0, ...m[2], 0, 0, 0, 0, 1); }

/** The UI has set the new lock. Rotate only the active camera to preserve its physical view. */
export function changeReferenceLockCamera(state: SimulationState, snapshot: ScienceSnapshot, previousLock: ReferenceLock): void {
  if (state.viewMode === 'ground') return;
  const camera = state.cameras[state.viewMode];
  const delta = multiplyMatrix(cameraFrameForLock(snapshot, camera.referenceLock), transpose(cameraFrameForLock(snapshot, previousLock)));
  const q = new Quaternion().setFromRotationMatrix(rotationMatrix(delta)).multiply(new Quaternion().fromArray(camera.orientationQuaternion)).normalize();
  camera.orientationQuaternion = q.toArray();
}

/** Changes the active camera only; `directionEqj` comes from the single core display resolver. */
export function focusDirectionCamera(state: SimulationState, snapshot: ScienceSnapshot, directionEqj: Vec3): void {
  const direction = new Vector3(...multiplyVector(cameraFrameForState(state, snapshot), directionEqj)).normalize();
  if (state.viewMode === 'ground') {
    const camera = state.cameras.ground, horizontal = Math.hypot(direction.x, direction.z);
    if (horizontal > 1e-12) camera.azimuthDegNorthEast = ((Math.atan2(direction.x, -direction.z) * 180 / Math.PI) % 360 + 360) % 360;
    camera.altitudeDeg = Math.atan2(direction.y, horizontal) * 180 / Math.PI;
    return;
  }
  const camera = state.cameras[state.viewMode], q = new Quaternion().fromArray(camera.orientationQuaternion);
  let cameraLocalTarget = new Vector3(0, 0, 1);
  if (state.viewMode === 'space') {
    // A geocentric orbit camera cannot put an infinite star at screen centre without Earth hiding it.
    const angle = Math.min(28, Math.max(6, camera.verticalFovDeg * .31)) * Math.PI / 180;
    const clearance = Math.max(3, angle * 180 / Math.PI - 3) * Math.PI / 180;
    camera.distanceDisplayUnits = Math.min(EXTERNAL_CAMERA_LIMITS.space.maxDistance,Math.max(camera.distanceDisplayUnits, 1 / Math.sin(clearance),EXTERNAL_CAMERA_LIMITS.space.minDistance));
    cameraLocalTarget = new Vector3(0, Math.sin(angle), -Math.cos(angle));
  }
  const currentWorldTarget = cameraLocalTarget.applyQuaternion(q);
  q.premultiply(new Quaternion().setFromUnitVectors(currentWorldTarget, direction)).normalize();
  camera.orientationQuaternion = q.toArray();
}

/** Fit the finite direction sphere to the viewport's smaller dimension without mutating saved zoom. */
export function finiteCameraDistance(distance: number, aspect: number): number {
  const safeDistance = Math.max(1.05,distance);
  return Math.sqrt(1+(safeDistance*safeDistance-1)/Math.min(1,Math.max(.05,aspect))**2);
}
