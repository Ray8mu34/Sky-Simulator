export interface InstrumentSettings { mode:'off'|'camera'|'eyepiece'; focalLengthMm:number; sensorWidthMm:number; sensorHeightMm:number; eyepieceMm:number; apparentFovDeg:number; rotationDeg:number }
export const defaultInstrument:InstrumentSettings={mode:'off',focalLengthMm:800,sensorWidthMm:23.5,sensorHeightMm:15.6,eyepieceMm:25,apparentFovDeg:60,rotationDeg:0};
export function validateInstrument(value:unknown):asserts value is InstrumentSettings {
  const v=value as InstrumentSettings;if(!v||!['off','camera','eyepiece'].includes(v.mode))throw Error('设备模式无效。');
  for(const [key,min,max]of [['focalLengthMm',10,20000],['sensorWidthMm',1,100],['sensorHeightMm',1,100],['eyepieceMm',1,100],['apparentFovDeg',10,120],['rotationDeg',-360,360]]as const)if(!Number.isFinite(v[key])||v[key]<min||v[key]>max)throw Error(`设备参数 ${key} 应为 ${min}–${max}。`);
}
export function instrumentField(v:InstrumentSettings){validateInstrument(v);const magnification=v.focalLengthMm/v.eyepieceMm;return {widthDeg:2*Math.atan(v.sensorWidthMm/(2*v.focalLengthMm))*180/Math.PI,heightDeg:2*Math.atan(v.sensorHeightMm/(2*v.focalLengthMm))*180/Math.PI,trueFovDeg:v.apparentFovDeg/magnification,magnification};}
