import type { DisplayZone, ObserverState, SimulationState } from '../contracts';
import { dateToUt, validateDisplayZone } from '../core/time';

/** Device clock and timezone are independent of geographic coordinates. */
export function deviceTime(now = new Date(), zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let displayZone: DisplayZone = { kind: 'fixed', offsetMinutes: -now.getTimezoneOffset() };
  if (zoneName && now.getFullYear() >= 1900 && now.getFullYear() <= 2100) {
    try {
      const candidate: DisplayZone = { kind: 'iana', name: zoneName, versionNote: '设备Intl时区规则；民用输入/导航仅1900–2100。' };
      validateDisplayZone(candidate); displayZone = candidate;
    } catch { /* A valid device UTC offset is the fallback if Intl has no usable zone. */ }
  }
  return { utDaysJ2000: dateToUt(now), displayZone };
}

export function useDeviceTime(state: SimulationState, running = false, now = new Date()): void {
  const device = deviceTime(now);
  state.time.utDaysJ2000 = device.utDaysJ2000;
  state.time.rateSimSecondsPerRealSecond = 1;
  state.time.running = running; state.time.mode = running ? 'realtime' : 'simulation';
  state.observer.displayZone = device.displayZone;
}

export function deviceObserver(coords: Pick<GeolocationCoordinates, 'latitude' | 'longitude' | 'altitude' | 'accuracy'>,
  displayZone: DisplayZone): { observer: ObserverState; altitudeEstimated: boolean; accuracy: number | null } {
  const { latitude, longitude, altitude, accuracy } = coords;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('设备返回的经纬度无效，请重试或选择地点。');
  }
  const hasAltitude = altitude !== null && Number.isFinite(altitude) && altitude >= -500 && altitude <= 100000;
  return { observer: { name: '设备当前位置', latitudeDeg: latitude, longitudeDegEast: longitude,
    heightMeters: hasAltitude ? altitude : 0, displayZone }, altitudeEstimated: !hasAltitude,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null };
}

export type LocationStatus = { phase: 'idle' | 'pending' | 'ready' | 'error'; message: string };

/** One-shot requests only. Cancel invalidates late browser callbacks; never watches movement. */
export function createDeviceLocation(geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined,
  onPosition: (position: GeolocationPosition) => string, onStatus: (status: LocationStatus) => void,
  secure = true) {
  let generation = 0, pending = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
  function cancel() { generation++; clearTimer(); pending = false; onStatus({ phase: 'idle', message: '' }); }
  function request() {
    if (disposed || pending) return;
    const ticket = ++generation;
    const settle = (phase: 'ready' | 'error', message: string) => {
      if (disposed || ticket !== generation || !pending) return;
      clearTimer(); pending = false; onStatus({ phase, message });
    };
    pending = true; onStatus({ phase: 'pending', message: '正在获取设备位置…' });
    if (!secure || !geolocation) { settle('error', '当前环境无法定位，请使用HTTPS网站或手动选择地点。'); return; }
    // Browser timeout may exclude time spent waiting for permission; bound the entire operation.
    timer = setTimeout(() => settle('error', '定位超时，请重试或手动选择地点。'), 20000);
    try {
      geolocation.getCurrentPosition(position => {
        if (disposed || ticket !== generation || !pending) return;
        try { settle('ready', onPosition(position)); }
        catch (error) { settle('error', error instanceof Error ? error.message : '定位失败，请重试或选择地点。'); }
      }, error => settle('error', error.code === 1 ? '未获定位权限，请在浏览器中允许位置访问，或手动选择地点。'
        : error.code === 3 ? '定位超时，请重试或手动选择地点。' : '暂时无法获取位置，请重试或手动选择地点。'),
      { enableHighAccuracy: false, maximumAge: 0, timeout: 15000 });
    } catch { settle('error', '无法获取位置，请检查浏览器权限或手动选择地点。'); }
  }
  return { request, cancel, dispose() { cancel(); disposed = true; } };
}
