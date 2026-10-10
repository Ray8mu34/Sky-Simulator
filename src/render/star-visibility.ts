/** Display visibility only; physical limits and scattering come from SkyAppearance. */
export const STAR_ALPHA_DISCARD = .005;
const MAGNITUDE_FADE_BELOW = .25;
const MAGNITUDE_FADE_ABOVE = .1;
const MAGNITUDE_ALPHA_EXPONENT = -.07;
const MAGNITUDE_ALPHA_FLOOR = .62;

export function starMagnitudeVisibility(magnitude:number,limit:number):number {
  const low=limit-MAGNITUDE_FADE_BELOW,high=limit+MAGNITUDE_FADE_ABOVE;
  const t=Math.max(0,Math.min(1,(magnitude-low)/(high-low)));
  return 1-t*t*(3-2*t);
}

/** Peak symbol alpha before point-kernel falloff. Canvas may supply its existing symbol alpha. */
export function finalStarAlpha(magnitude:number,limit:number,starVisibility=1,hemisphere=1,symbolAlphaOverride?:number):number {
  const symbol=symbolAlphaOverride??Math.max(MAGNITUDE_ALPHA_FLOOR,Math.min(1,10**(MAGNITUDE_ALPHA_EXPONENT*(magnitude-1))));
  return starMagnitudeVisibility(magnitude,limit)*starVisibility*hemisphere*symbol;
}

export const STAR_VISIBILITY_GLSL = `
const float STAR_ALPHA_DISCARD=${STAR_ALPHA_DISCARD};
float skyStarMagnitudeVisibility(float magnitude,float limit){
  return 1.0-smoothstep(limit-${MAGNITUDE_FADE_BELOW},limit+${MAGNITUDE_FADE_ABOVE},magnitude);
}
float skyFinalStarAlpha(float magnitude,float limit,float visibility,float hemisphere){
  return skyStarMagnitudeVisibility(magnitude,limit)*visibility*hemisphere*clamp(pow(10.0,${MAGNITUDE_ALPHA_EXPONENT}*(magnitude-1.0)),${MAGNITUDE_ALPHA_FLOOR},1.0);
}
`;
