import { getRefractionShaderChunk } from '../core/refraction';
const refractionChunk=getRefractionShaderChunk();
export const directionVertex = `${refractionChunk}
uniform mat3 uFrame;
uniform float uFinite;
uniform float uRadius;
uniform float uBackAlpha;
uniform float uGround;
uniform float uTerrain;
uniform float uRimFade;
varying float vHemisphere;
varying vec3 vDirection;
#ifdef LOCAL_REFERENCE_CLASS
attribute float refractionClass;
#endif
vec4 directionPosition(vec3 p) {
  vec3 world = uFrame * p;
  bool mapCelestial=true;
  #ifdef LOCAL_REFERENCE_CLASS
  mapCelestial=refractionClass>.5;
  #endif
  if(uGround>.5 && mapCelestial){vec3 enu=skyRefractEnu(vec3(world.x,-world.z,world.y));world=vec3(enu.x,enu.z,-enu.y);}
  vDirection=world;
  vHemisphere=1.0;
  if(uFinite>.5) {
    float facing=dot(normalize(world),normalize(cameraPosition-world*uRadius));
    float rim=mix(1.0,mix(.22,1.0,smoothstep(.015,.35,abs(facing))),uRimFade);
    vHemisphere=(facing<0.0 ? uBackAlpha : 1.0)*rim;
  }
  float az=atan(world.x,-world.z);
  float hill=.010+.007*sin(az*7.0+1.4)+.008*sin(az*3.0-1.0)+.003*sin(az*13.0);
  if(uGround>.5 && uTerrain>.5 && world.y<hill) vHemisphere=0.0;
  if (uFinite > .5) return projectionMatrix * viewMatrix * vec4(world * uRadius, 1.0);
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * world * 100.0, 1.0);
  clip.z = clip.w * .99999;
  return clip;
}`;

export const starVertex = `${directionVertex}
attribute float magnitude;
attribute vec3 starColor;
uniform float uDpr;
uniform float uLimit;
uniform float uVisibility;
varying vec3 vColor;
varying float vAlpha;
varying float vBright;
void main() {
  gl_Position = directionPosition(position);
  float visibility = 1.0 - smoothstep(uLimit - .25, uLimit + .1, magnitude);
  vAlpha = visibility * uVisibility * vHemisphere * clamp(pow(10.0, -.07 * (magnitude - 1.0)), .62, 1.0);
  vBright = 1.0 - smoothstep(.0, 1.7, magnitude);
  gl_PointSize = max(2.1 * uDpr, (5.0 - .50 * magnitude) * uDpr);
  vColor = starColor;
}`;

export const starFragment = `
uniform float uGround;
uniform float uTerrain;
varying vec3 vDirection;
varying vec3 vColor;
varying float vAlpha;
varying float vBright;
void main() {
  vec3 d=normalize(vDirection); float az=atan(d.x,-d.z);
  float hill=.010+.007*sin(az*7.0+1.4)+.008*sin(az*3.0-1.0)+.003*sin(az*13.0);
  if(uGround>.5 && uTerrain>.5 && d.y<hill) discard;
  float r = length(gl_PointCoord - .5) * 2.0;
  if (r > 1.0 || vAlpha < .005) discard;
  float core = 1.0 - smoothstep(.50, .92, r);
  float halo = exp(-r * r * 7.0) * .20 * vBright;
  gl_FragColor = vec4(vColor * 1.12, vAlpha * max(core, halo));
  #include <colorspace_fragment>
}`;

export const lineVertex = `${directionVertex}
#ifndef UNIFORM_LINE_COLOR
attribute vec3 lineColor;
#endif
uniform float uUseTint;
uniform vec3 uTint;
varying vec3 vColor;
void main() { gl_Position = directionPosition(position);
  #ifdef UNIFORM_LINE_COLOR
  vColor=uTint;
  #else
  vColor = mix(lineColor,uTint,uUseTint);
  #endif
}
`;
export const lineFragment = `
uniform float uAlpha;
uniform float uGround;
uniform float uTerrain;
uniform float uFinite;
uniform float uRadius;
uniform float uBackAlpha;
uniform float uRimFade;
varying vec3 vDirection;
varying float vHemisphere;
varying vec3 vColor;
void main() {
  vec3 d=normalize(vDirection); float az=atan(d.x,-d.z);
  float hill=.010+.007*sin(az*7.0+1.4)+.008*sin(az*3.0-1.0)+.003*sin(az*13.0);
  if(uGround>.5 && uTerrain>.5 && d.y<hill) discard;
  float alpha=vHemisphere;
  if(uFinite>.5) {
    float facing=dot(d,normalize(cameraPosition-d*uRadius));
    float rim=mix(1.0,mix(.22,1.0,smoothstep(.015,.35,abs(facing))),uRimFade);
    alpha=(facing<0.0 ? uBackAlpha : 1.0)*rim;
  }
  gl_FragColor = vec4(vColor, uAlpha * alpha);
  #include <colorspace_fragment>
}`;

/** Atmospheric approximation driven exclusively by the computed Sun direction/altitude. */
export const backgroundVertex = `
varying vec2 vNdc;
void main(){ vNdc=position.xy; gl_Position=vec4(position.xy, .999999, 1.0); }
`;
const skyRadianceFragmentPrefix = `${refractionChunk}
varying vec2 vNdc;
uniform mat3 uCameraRotation;
uniform float uAspect;
uniform float uTanFov;
uniform mat3 uFrameInverse;
uniform float uFinite;
uniform float uRadius;
uniform float uBackAlpha;
uniform sampler2D uMilkyWay;
uniform float uHasMilkyWay;
uniform float uMilkyWayEnabled;
uniform float uMilkyWayContrast;
uniform vec3 uBackgroundLinearRgb;
uniform vec3 uHorizonGlowLinearRgb;
uniform float uDaylightStrength;
uniform float uTerrain;
uniform float uGround;
vec3 milkyWayRadiance(vec3 worldDirection) {
  if(uMilkyWayEnabled<.5||uHasMilkyWay<.5||uMilkyWayContrast<=0.0)return vec3(0.0);
  if(uGround>.5){vec3 enu=skyUnrefractEnu(vec3(worldDirection.x,-worldDirection.z,worldDirection.y));worldDirection=vec3(enu.x,enu.z,-enu.y);}
  vec3 eqj=normalize(uFrameInverse*worldDirection);
  vec2 uv=vec2(fract(.5-atan(eqj.y,eqj.x)/6.28318530718),.5+asin(clamp(eqj.z,-1.0,1.0))/3.14159265359);
  vec2 dx=dFdx(uv),dy=dFdy(uv);
  // Repeat wrapping alone does not correct atan/fract's seam derivatives and mip level.
  dx.x-=floor(dx.x+.5);dy.x-=floor(dy.x+.5);
  vec3 source=textureGrad(uMilkyWay,uv,dx,dy).rgb;
  float luma=dot(source,vec3(.2126,.7152,.0722));
  return mix(vec3(luma),source,.15)*.085*uMilkyWayContrast*uHasMilkyWay*uMilkyWayEnabled;
}
float shellWeight(vec3 direction) {
  float facing=dot(direction,normalize(cameraPosition-direction*uRadius));
  float rim=mix(.22,1.0,smoothstep(.015,.35,abs(facing)));
  return (facing<0.0?uBackAlpha:1.0)*rim;
}
vec3 shellIntersections(vec3 ray) {
  float b=dot(cameraPosition,ray),c=dot(cameraPosition,cameraPosition)-uRadius*uRadius;
  float discriminant=b*b-c,root=sqrt(max(0.0,discriminant));
  return vec3(-b-root,-b+root,discriminant);
}
`;
export const backgroundFragment = `${skyRadianceFragmentPrefix}
void main() {
  vec3 ray = normalize(uCameraRotation * vec3(vNdc.x * uAspect * uTanFov, vNdc.y * uTanFov, -1.0));
  vec3 color = uBackgroundLinearRgb;
  vec3 galaxy=vec3(0.0);
  if(uFinite>.5) {
    vec3 roots=shellIntersections(ray);
    float tNear=roots.x,tFar=roots.y;
    vec3 farDirection=normalize(cameraPosition+ray*tFar);
    vec3 farLight=milkyWayRadiance(farDirection)*shellWeight(farDirection);
    if(roots.z>=0.0&&tNear>0.0&&tFar-tNear>1e-5)galaxy=farLight;
  }else galaxy=milkyWayRadiance(ray);
  if (uGround > .5) {
    float haze = exp(-max(ray.y,0.0)*3.0);
    color=mix(uBackgroundLinearRgb,uHorizonGlowLinearRgb,haze);
    float az = atan(ray.x,-ray.z);
    float hill = .010 + .007*sin(az*7.0+1.4) + .008*sin(az*3.0-1.0) + .003*sin(az*13.0);
    if (uTerrain > .5 && ray.y < hill) {
      float texture = .6 + .15*sin(az*87.0+ray.y*130.0) + .08*sin(az*153.0-ray.y*230.0);
      color = mix(vec3(.0013,.0018,.0014), vec3(.036,.049,.029),uDaylightStrength) * texture;
      galaxy=vec3(0.0);
    }
  }
  gl_FragColor = vec4(color+galaxy,1.0);
  #include <colorspace_fragment>
}`;

/** Finite near shell is in front of the centre Earth and uses its actual projected depth. */
export const galaxyNearFragment = `${skyRadianceFragmentPrefix}
uniform mat4 uViewProjection;
void main() {
  if(uMilkyWayEnabled<.5||uHasMilkyWay<.5||uMilkyWayContrast<=0.0)discard;
  vec3 ray=normalize(uCameraRotation*vec3(vNdc.x*uAspect*uTanFov,vNdc.y*uTanFov,-1.0));
  vec3 roots=shellIntersections(ray);
  if(roots.z<0.0||roots.x<=0.0)discard;
  vec3 shellPoint=cameraPosition+ray*roots.x,direction=normalize(shellPoint);
  vec3 color=milkyWayRadiance(direction)*shellWeight(direction);
  if(max(max(color.r,color.g),color.b)<=1e-8)discard;
  vec4 clip=uViewProjection*vec4(shellPoint,1.0);
  gl_FragDepth=(clip.z/clip.w)*.5+.5;
  gl_FragColor=vec4(color,1.0);
  #include <colorspace_fragment>
}`;

export const earthVertex = `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main() {
  vUv=uv;
  vWorldNormal=normalize(mat3(modelMatrix)*normal);
  vWorldPosition=(modelMatrix*vec4(position,1.0)).xyz;
  gl_Position=projectionMatrix*viewMatrix*vec4(vWorldPosition,1.0);
}`;
/** Screen bounds affect coverage only; fragment rays define the actual warped physical disc. */
export const observedBodyVertex = `
uniform bool uDiscWarpActive;
uniform vec4 uDiscBoundsNdc;
varying vec2 vBodyNdc;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main(){
  vUv=uv;vWorldNormal=normalize(mat3(modelMatrix)*normal);vWorldPosition=(modelMatrix*vec4(position,1.0)).xyz;
  if(uDiscWarpActive){vBodyNdc=mix(uDiscBoundsNdc.xy,uDiscBoundsNdc.zw,uv);gl_Position=vec4(vBodyNdc,.9999,1.0);}
  else{gl_Position=projectionMatrix*viewMatrix*vec4(vWorldPosition,1.0);vBodyNdc=gl_Position.xy/gl_Position.w;}
}`;
const observedBodyRayChunk=`${refractionChunk}
uniform bool uDiscWarpActive;
uniform mat3 uDiscPhysicalBasis;
uniform vec3 uDiscGeometricCentre;
uniform vec3 uDiscObservedCentreEnu;
uniform float uDiscTanRadius;
uniform float uDiscTeachingScale;
uniform mat3 uDiscCameraRotation;
uniform float uDiscAspect;
uniform float uDiscTanFov;
varying vec2 vBodyNdc;
vec3 discDisplayRay(){return normalize(uDiscCameraRotation*vec3(vBodyNdc.x*uDiscAspect*uDiscTanFov,vBodyNdc.y*uDiscTanFov,-1.0));}
vec2 inversePhysicalDisc(vec3 displayedRay){
  vec3 enu=vec3(displayedRay.x,-displayedRay.z,displayedRay.y);
  float axial=dot(enu,uDiscObservedCentreEnu),s=1.0/uDiscTeachingScale;
  enu=normalize(s*enu+(1.0-s)*uDiscObservedCentreEnu*axial);
  enu=skyUnrefractEnu(enu);vec3 geometric=vec3(enu.x,enu.z,-enu.y);
  float denominator=dot(geometric,uDiscGeometricCentre)*uDiscTanRadius;
  if(denominator<=0.0)discard;
  return vec2(dot(geometric,uDiscPhysicalBasis[0]),dot(geometric,uDiscPhysicalBasis[1]))/denominator;
}
`;
export const earthFragment = `
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform vec3 uSunDirection;
uniform float uHasDay;
uniform float uHasNight;
uniform float uHasClouds;
uniform float uDayEnabled;
uniform float uNightEnabled;
uniform float uCloudEnabled;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main() {
  vec3 n=normalize(vWorldNormal);
  float mu=dot(n,uSunDirection);
  float light=max(mu,0.0);
  vec3 surface=mix(vec3(.025,.060,.09),texture2D(uDay,vUv).rgb,uHasDay*uDayEnabled);
  float cloud=texture2D(uClouds,vUv).r*uHasClouds*uCloudEnabled;
  // Masks are linear; color samplers are decoded from sRGB by their texture formats.
  surface=mix(surface,vec3(.69,.73,.75),pow(cloud,1.45)*.48);
  vec3 color=surface*(.005+light*.95);
  float night=1.0-smoothstep(-.16,0.,mu);
  color+=texture2D(uNight,vUv).rgb*uHasNight*uNightEnabled*night*.7;
  vec3 eye=normalize(cameraPosition-vWorldPosition);
  float oceanSpec=pow(max(dot(reflect(-uSunDirection,n),eye),0.0),60.0);
  color+=vec3(.16,.18,.18)*oceanSpec*light*(1.0-cloud);
  gl_FragColor=vec4(color,1.0);
  #include <colorspace_fragment>
}`;
export const atmosphereFragment = `
uniform vec3 uSunDirection;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main() {
  vec3 n=normalize(vWorldNormal), eye=normalize(cameraPosition-vWorldPosition);
  float rim=pow(1.0-abs(dot(n,eye)),6.0);
  float daylight=smoothstep(-.24,.3,dot(n,uSunDirection));
  gl_FragColor=vec4(vec3(.12,.34,.67),rim*daylight*.48);
  #include <colorspace_fragment>
}`;
export const bodyFragment = `${observedBodyRayChunk}
uniform vec3 uSunDirection;
uniform vec3 uColor;
uniform float uSelfLuminous;
uniform float uGround;
uniform float uTerrain;
uniform float uVisibility;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main() {
  vec3 d=uDiscWarpActive?discDisplayRay():normalize(vWorldPosition-cameraPosition);
  if(uDiscWarpActive){vec2 p=inversePhysicalDisc(d);if(dot(p,p)>1.0)discard;}
  float az=atan(d.x,-d.z);
  float hill=.010+.007*sin(az*7.0+1.4)+.008*sin(az*3.0-1.0)+.003*sin(az*13.0);
  if(uGround>.5 && uTerrain>.5 && d.y<hill) discard;
  float light=uSelfLuminous>.5 ? 1.0 : .018+max(dot(normalize(vWorldNormal),uSunDirection),0.0)*.9;
  gl_FragColor=vec4(uColor*light,uVisibility);
  #include <colorspace_fragment>
}`;

/** Color-only NASA map; no displacement, invented earthshine, or eclipse shadow. */
export const moonFragment = `${observedBodyRayChunk}
uniform sampler2D uMoon;
uniform float uHasMoon;
uniform mat3 uDiscToBodyFixed;
uniform mat3 uDiscToDisplay;
uniform vec3 uSunDirection;
uniform float uGround;
uniform float uTerrain;
uniform float uVisibility;
uniform float uScatterEnabled;
uniform vec3 uBackgroundLinearRgb;
uniform vec3 uHorizonGlowLinearRgb;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main() {
  vec3 d=uDiscWarpActive?discDisplayRay():normalize(vWorldPosition-cameraPosition);
  vec2 p=uDiscWarpActive?inversePhysicalDisc(d):(vUv-.5)*2.0;
  float rho=dot(p,p);
  if(rho>1.0) discard;
  // Orthographic physical observation of a spherical Moon, independent of drawing-camera distance.
  vec3 normalDisc=vec3(p,sqrt(max(0.0,1.0-rho)));
  vec3 fixedNormal=normalize(uDiscToBodyFixed*normalDisc);
  vec2 lunarUv=vec2(.5+atan(fixedNormal.y,fixedNormal.x)/6.28318530718,.5+asin(clamp(fixedNormal.z,-1.0,1.0))/3.14159265359);
  float az=atan(d.x,-d.z);
  float hill=.010+.007*sin(az*7.0+1.4)+.008*sin(az*3.0-1.0)+.003*sin(az*13.0);
  if(uGround>.5 && uTerrain>.5 && d.y<hill) discard;
  vec3 surface=mix(vec3(.46),texture2D(uMoon,lunarUv).rgb,uHasMoon);
  float mu=max(dot(uDiscToDisplay*normalDisc,uSunDirection),0.0);
  vec3 scatter=uGround>.5&&uScatterEnabled>.5?mix(uBackgroundLinearRgb,uHorizonGlowLinearRgb,exp(-max(d.y,0.0)*3.0)):vec3(0.0);
  gl_FragColor=vec4(surface*mu*1.1+scatter,uVisibility);
  #include <colorspace_fragment>
}`;
