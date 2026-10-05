import * as Engine from 'astronomy-engine';
import type { ObserverState } from '../contracts';
import { mod } from './math';

export function validateObserver(observer: ObserverState): void {
  if (!Number.isFinite(observer.latitudeDeg) || Math.abs(observer.latitudeDeg) > 90) throw new RangeError('地理纬度须在 ±90° 内。');
  if (!Number.isFinite(observer.longitudeDegEast) || Math.abs(observer.longitudeDegEast) > 180) throw new RangeError('东正地理经度须在 ±180° 内。');
  if (!Number.isFinite(observer.heightMeters) || observer.heightMeters < -500 || observer.heightMeters > 100_000) throw new RangeError('海拔须在 −500 至 100000 米内。');
}
export function makeObserver(observer: ObserverState): Engine.Observer {
  validateObserver(observer);
  return new Engine.Observer(observer.latitudeDeg, mod(observer.longitudeDegEast + 180, 360) - 180, observer.heightMeters);
}
