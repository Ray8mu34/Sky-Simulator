import * as Engine from 'astronomy-engine';
import type { Mat3, ObserverState, Vec3 } from '../contracts';
import { mod, negate } from './math';
import { makeObserver } from './observer';

export interface ObserverFrame {
  readonly utDaysJ2000: number;
  readonly ttDaysJ2000: number;
  readonly gastHours: number;
  readonly lstHours: number;
  readonly eqjToHorizontalGeometric: Mat3;
  readonly localZenithEqjUnit: Vec3;
}

/** AE rot[col][row] becomes our mathematical row-major matrix. */
export function fromEngineRotation(rotation: Engine.RotationMatrix): Mat3 {
  const m = rotation.rot;
  return [[m[0]![0]!, m[1]![0]!, m[2]![0]!], [m[0]![1]!, m[1]![1]!, m[2]![1]!], [m[0]![2]!, m[1]![2]!, m[2]![2]!]];
}

/** Internal adapter for an already-created time; no body ephemerides or second clock. */
export function frameFromEngineTime(time: Engine.AstroTime, observer: Engine.Observer): ObserverFrame {
  const gastHours = Engine.SiderealTime(time);
  const nwu = fromEngineRotation(Engine.Rotation_EQJ_HOR(time, observer));
  const eqjToHorizontalGeometric: Mat3 = [negate(nwu[1]), nwu[0], nwu[2]];
  return { utDaysJ2000: time.ut, ttDaysJ2000: time.tt, gastHours,
    lstHours: mod(gastHours + observer.longitude / 15, 24), eqjToHorizontalGeometric,
    localZenithEqjUnit: eqjToHorizontalGeometric[2] };
}

/** Mathematical finite-time frame. Public science entry points enforce their UT domain. */
export function computeObserverFrame(utDaysJ2000: number, observer: ObserverState): ObserverFrame {
  if (!Number.isFinite(utDaysJ2000)) throw new RangeError('坐标frame的UT须有限。');
  return frameFromEngineTime(new Engine.AstroTime(utDaysJ2000), makeObserver(observer));
}
