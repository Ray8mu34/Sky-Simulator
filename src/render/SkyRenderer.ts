import * as THREE from 'three';
import type { Mat3, MoonAppearance, ObjectId, RuntimeMetrics, ScienceSnapshot, SimulationState, Vec3, ViewMode } from '../contracts';
import type { GraphicsContextState } from '../platform/renderer-port';
import {DEFAULT_RUNTIME_RENDER_QUALITY,renderBudgetClass} from '../platform/runtime-quality-contract';
import type {RuntimeRenderQuality,RuntimeQualityCapabilities,QualityDeviceClass} from '../platform/runtime-quality-contract';
import {runtimeLabelSecondary,runtimeLabelIsHiddenBack,runtimeOrdinaryLabelBudget,sameRuntimeRenderQuality,WEBGL_RUNTIME_QUALITY_CAPABILITIES} from './RenderQuality';
import { catalog } from '../data/catalog';
import { cachedStarEpoch, writeStarDirectionBuffer, STAR_CACHE_STEP_DAYS, STAR_MOTION_CACHE_BOUND_ARCSEC, STAR_FLOAT32_DIRECTION_BOUND_ARCSEC, STAR_CACHE_DIRECTION_BOUND_ARCSEC } from './StarDirectionBuffer';
import { ASTROMETRY_MODEL_VERSION, deriveStarMotionModel } from '../core/stars';
import { resolveCatalogStar } from '../data/search';
import { resolveDisplayDirectionEqj, resolveObjectDetails, resolveObjectDirectionEqj } from '../core/object-details';
import { resolveLunarAppearance } from '../core/moon';
import { deriveSkyAppearance } from '../core/sky-appearance';
import { getDisplayRefractionProfile } from '../core/refraction';
import type { RefractionProfile } from '../core/refraction';
import { RefractionGpuBridge } from './RefractionGpuBridge';
import { displayDirection,geometricDisplayRay } from './DisplayDirection';
import { createRefractedDisc,discDisplayRay,inverseDiscCoordinates,refractedDiscBounds,projectDiscRay } from './RefractedDisc';
import type { RefractedDisc } from './RefractedDisc';
import { queueBufferUpdate } from './BufferUpdates';
import { createArcProjector } from './ArcProjection';
import { ArcKnotsCache } from './ArcKnotsCache';
import { createSphericalArcBuffer,updateSphericalArcBuffer,writeConstellationHighlight,minorArcAltitudeCrossings,createMinorArcSampler,minorArcDirectionAt } from './SphericalArcBuffer';
import type { SkyAppearance } from '../core/sky-appearance';
import { earthDayUrl, earthNightUrl, earthCloudsUrl } from '../data/textures';
import { moonColorUrl } from '../data/moon';
import { desktopUrl as milkyWayDesktopUrl,mobileUrl as milkyWayMobileUrl,metadata as milkyWayMetadata,directionSamples as milkyWayDirections } from '../data/milky-way';
import { milkyWayUv } from './MilkyWay';
import { createPointerGesture,gestureActiveContacts,gestureMode,reducePointerGesture } from './PointerGestures';
import type { PointerGestureInput } from './PointerGestures';
import { applyCameraPan,applyCameraZoom } from './CameraGestureActions';
import { brightLimbScreenUnit, lunarDiscTransform, observationBasis, perspectiveTangentScreenUnit, unmagnifiedDiscDiameter } from './LunarDisc';
import { LabelLayer } from './LabelLayer';
import type { LabelCandidate } from './LabelLayer';
import { readSkyOcclusions } from './Occlusion';
import { cappedPixelRatio, EQJ_TO_THREE, geographicToThree, multiplyMatrix, multiplyVector, rayHitsSphere, sphereFacing, transpose } from './coordinates';
import { cameraFrameForState, changeReferenceLockCamera, finiteCameraDistance, focusDirectionCamera } from './CameraActions';
import type { ReferenceLock } from './CameraActions';
import { EXTERNAL_CAMERA_LIMITS } from '../camera-limits';
import { atmosphereFragment, backgroundFragment, backgroundVertex, bodyFragment, earthFragment, earthVertex, observedBodyVertex,galaxyNearFragment, lineFragment, lineVertex, moonFragment, starFragment, starVertex } from './shaders';

export const supportedModes = ['ground', 'space', 'globe', 'horizon'] as const;
const RAD = Math.PI / 180;
const referenceCos=Float64Array.from({length:721},(_,i)=>Math.cos(i*Math.PI/360));
const referenceSin=Float64Array.from({length:721},(_,i)=>Math.sin(i*Math.PI/360));
// Every half-degree minor-arc point is within .25° of an endpoint.
const referenceAltitudeGuard=2*Math.sin(Math.PI/1440)+1e-12;
const asThree = (v: Vec3): THREE.Vector3 => new THREE.Vector3(...v);
function matrix3(m: Mat3): THREE.Matrix3 { return new THREE.Matrix3().set(...m[0], ...m[1], ...m[2]); }
function matrix4(m: Mat3): THREE.Matrix4 {
  return new THREE.Matrix4().set(...m[0], 0, ...m[1], 0, ...m[2], 0, 0, 0, 0, 1);
}
function rowsOf(m:THREE.Matrix3):Mat3 {const e=m.elements;return [[e[0]!,e[3]!,e[6]!],[e[1]!,e[4]!,e[7]!],[e[2]!,e[5]!,e[8]!]];}
function hillHeight(direction: THREE.Vector3): number {
  const az = Math.atan2(direction.x, -direction.z);
  return .010 + .007 * Math.sin(az * 7 + 1.4) + .008 * Math.sin(az * 3 - 1) + .003 * Math.sin(az * 13);
}

/** Owns the only WebGL context. The application owns scheduling; no internal RAF. */
export class SkyRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, 1, .01, 2000);
  private readonly labels: LabelLayer;
  private readonly refractionBridge=new RefractionGpuBridge();
  private refractionProfile:RefractionProfile|null=null;
  private readonly sharedUniforms = {
    ...this.refractionBridge.uniforms,
    uFrame: { value: new THREE.Matrix3() }, uFinite: { value: 0 }, uRadius: { value: 1 },
    uBackAlpha: { value: .13 }, uGround: { value: 1 }, uTerrain: { value: 1 }, uRimFade: { value: 1 },
  };
  private readonly starMaterial: THREE.ShaderMaterial;
  private readonly stars: THREE.Points;
  private readonly lineMaterial: THREE.ShaderMaterial;
  private readonly constellationLines: THREE.LineSegments;
  private readonly selectionLines: THREE.LineSegments;
  private readonly arcBuffer=createSphericalArcBuffer({starCount:catalog.stars.length,lineIndices:catalog.lineIndices,figures:catalog.constellations,maxSegmentsPerArc:128,maxExtraKnotsPerArc:8});
  private lastArcKey='';
  private readonly arcKnots=new ArcKnotsCache(catalog.lineIndices);
  private readonly arcPositionShadow=new Float32Array(this.arcBuffer.positions.length);
  private readonly arcIndexShadow=new Uint32Array(this.arcBuffer.ordinaryIndex.length);
  private arcUpdateCount=0;
  private shadowStarEpoch=Infinity;
  private arcPhases={knotsMs:0,deriveMs:0,changeDetectionMs:0};
  private arcUpdateMs=0;
  private arcUploadBytes=0;
  private arcUploadBytesTotal=0;
  private renderPhases={bodiesMs:0,referencesMs:0,sceneSubmitMs:0,labelsMs:0};
  private readonly referenceMaterial: THREE.ShaderMaterial;
  private readonly referenceLines: THREE.LineSegments;
  private readonly referencePositions = new Float32Array(18000);
  private readonly referenceColors = new Float32Array(18000);
  private readonly referenceClasses = new Float32Array(6000);
  private readonly background: THREE.Mesh;
  private readonly galaxyNear:THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
  private readonly earthGroup = new THREE.Group();
  private readonly earth: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly atmosphere: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly observerMarker = new THREE.Mesh(new THREE.SphereGeometry(.014, 10, 8), new THREE.MeshBasicMaterial({ color: '#c8dfed' }));
  private readonly horizonPlane = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({ color: '#3c7a69', transparent: true, opacity: .09, side: THREE.DoubleSide, depthWrite: false }));
  private readonly bodies = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>();
  private readonly physicalSunGeometry=new THREE.SphereGeometry(1,32,24);
  private readonly groundDiscs=new Map<string,{disc:RefractedDisc,bounds:[number,number,number,number]|null}>();
  private readonly loupeScene=new THREE.Scene();
  private readonly loupeCamera=new THREE.OrthographicCamera(-1.28,1.28,1.28,-1.28,.01,100);
  private readonly loupeMoon:THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
  private loupeViewport:{left:number;top:number;width:number;height:number}|null=null;
  private lunarAppearance:MoonAppearance|null=null;
  private lunarTransform:ReturnType<typeof lunarDiscTransform>|null=null;
  private mainUnmagnifiedMoonDiameter=0;
  private loupeDiameter=0;
  private readonly resources = new Set<THREE.Texture>();
  private readonly loadedTextures: THREE.Texture[] = [];
  private readonly pendingAssets = new Set<string>();
  private readonly loadedAssets = new Set<string>();
  private readonly assetErrors = new Map<string, string>();
  private readonly frameSamples: number[] = [];
  private skyAppearance:SkyAppearance|null=null;
  private milkyWayTexture:THREE.Texture|null=null;
  private milkyWayTier:'1k'|'2k'|null=null;
  private requestedMilkyWayTier:'1k'|'2k'|null=null;
  private milkyWayGeneration=0;
  private state: SimulationState | null = null;
  private snapshot: ScienceSnapshot | null = null;
  private frame: Mat3 = EQJ_TO_THREE;
  private width = 1;
  private height = 1;
  private ratio = 1;
  private baselineRatio=1;
  private budgetClass:QualityDeviceClass='desktop';
  private runtimeQuality:Readonly<RuntimeRenderQuality>=DEFAULT_RUNTIME_RENDER_QUALITY;
  private stageInputEnabled=true;
  private qualityBackLabelsSkipped=0;
  private qualitySecondaryLabelsOmitted=0;
  private finite = false;
  private disposed = false;
  private lastReferenceKey = '';
  private gesture=createPointerGesture();
  private gestureView:ViewMode|null=null;
  private readonly capturedPointers=new Set<number>();
  private contextLost=false;
  private projectedStars: { id: ObjectId; x: number; y: number; magnitude: number }[] = [];
  private selectedLabelAnchorPixel:{x:number;y:number}|null=null;
  private selectionMarkerPixel:{x:number;y:number}|null=null;
  private readonly starDirections = this.arcBuffer.starDirections;
  private readonly constellationDirections = new Map<string, Vec3>();
  private lastStarEpoch = Infinity;
  private lastSelection: ObjectId | null | undefined;
  private canonicalSelected: ObjectId | null = null;
  private projectedBodies:{id:ObjectId,x:number,y:number,radius:number}[]=[];
  private readonly resizeObserver: ResizeObserver;
  private readonly referenceIds=new WeakMap<object,number>();
  private nextReferenceId=1;

  constructor(private readonly container: HTMLElement, private readonly onCameraChange: () => void, private readonly onSelect?: (id: ObjectId | null) => void,
    private readonly onContextState?:(state:GraphicsContextState)=>void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    try {
    this.resources.add(this.refractionBridge.texture);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.info.autoReset = false;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'sky-webgl-canvas';
    this.canvas.setAttribute('aria-label', '交互式星空，拖动转动视角，滚轮缩放');
    this.canvas.setAttribute('role', 'img');
    this.canvas.tabIndex = 0;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
    container.append(this.canvas);
    this.labels = new LabelLayer(container,this.onCameraChange);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.arcBuffer.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0,catalog.stars.length);
    geometry.setAttribute('magnitude', new THREE.BufferAttribute(catalog.magnitudes, 1));
    geometry.setAttribute('starColor', new THREE.BufferAttribute(catalog.colors, 3));
    this.starMaterial = new THREE.ShaderMaterial({ vertexShader: starVertex, fragmentShader: starFragment, uniforms: {
      ...this.sharedUniforms, uDpr: { value: 1 }, uLimit: { value: 6.5 }, uVisibility: { value: 1 },
    }, transparent: true, depthWrite: false, depthTest: true });
    this.stars = new THREE.Points(geometry, this.starMaterial); this.stars.frustumCulled = false; this.stars.renderOrder = 1;
    this.scene.add(this.stars);

    // All view modes and constellation segments share the original typed position buffer.
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', geometry.getAttribute('position'));
    lineGeometry.setIndex(new THREE.BufferAttribute(this.arcBuffer.ordinaryIndex, 1).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setDrawRange(0,0);
    this.lineMaterial = new THREE.ShaderMaterial({ defines:{UNIFORM_LINE_COLOR:1},vertexShader: lineVertex, fragmentShader: lineFragment, uniforms: { ...this.sharedUniforms, uAlpha: { value: .45 }, uUseTint: {value:1}, uTint:{value:new THREE.Vector3(.19,.23,.27)} }, transparent: true, depthWrite: false });
    this.constellationLines = new THREE.LineSegments(lineGeometry, this.lineMaterial);
    this.constellationLines.frustumCulled = false; this.constellationLines.renderOrder = 2; this.scene.add(this.constellationLines);
    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position',geometry.getAttribute('position'));
    highlightGeometry.setIndex(new THREE.BufferAttribute(this.arcBuffer.highlightIndex,1).setUsage(THREE.DynamicDrawUsage));
    highlightGeometry.setDrawRange(0,0);
    this.selectionLines = new THREE.LineSegments(highlightGeometry,new THREE.ShaderMaterial({defines:{UNIFORM_LINE_COLOR:1},vertexShader:lineVertex,fragmentShader:lineFragment,uniforms:{...this.sharedUniforms,uAlpha:{value:.85},uUseTint:{value:1},uTint:{value:new THREE.Vector3(.34,.48,.60)}},transparent:true,depthWrite:false}));
    this.selectionLines.frustumCulled=false;this.selectionLines.renderOrder=3;this.selectionLines.visible=false;this.scene.add(this.selectionLines);

    const refs = new THREE.BufferGeometry();
    refs.setAttribute('position', new THREE.BufferAttribute(this.referencePositions, 3).setUsage(THREE.DynamicDrawUsage));
    refs.setAttribute('lineColor', new THREE.BufferAttribute(this.referenceColors, 3).setUsage(THREE.DynamicDrawUsage));
    refs.setAttribute('refractionClass',new THREE.BufferAttribute(this.referenceClasses,1).setUsage(THREE.DynamicDrawUsage));
    refs.setDrawRange(0, 0);
    this.referenceMaterial = new THREE.ShaderMaterial({ defines:{LOCAL_REFERENCE_CLASS:1},vertexShader: lineVertex, fragmentShader: lineFragment, uniforms: { ...this.sharedUniforms, uRimFade:{value:0}, uAlpha: { value: .50 }, uUseTint:{value:0},uTint:{value:new THREE.Vector3()} }, transparent: true, depthWrite: false });
    this.referenceLines = new THREE.LineSegments(refs, this.referenceMaterial);
    this.referenceLines.frustumCulled = false; this.referenceLines.renderOrder = 3; this.scene.add(this.referenceLines);

    this.background = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: backgroundVertex, fragmentShader: backgroundFragment, uniforms: {
      ...this.refractionBridge.uniforms,
      uCameraRotation: { value: new THREE.Matrix3() }, uAspect: { value: 1 }, uTanFov: { value: .6 },uFrameInverse:{value:new THREE.Matrix3()},
      uFinite:this.sharedUniforms.uFinite,uRadius:this.sharedUniforms.uRadius,uBackAlpha:this.sharedUniforms.uBackAlpha,
      uMilkyWay:{value:this.emptyTexture([0,0,0,255],true)},uHasMilkyWay:{value:0},uMilkyWayEnabled:{value:0},uMilkyWayContrast:{value:1},
      uBackgroundLinearRgb:{value:new THREE.Vector3()},uHorizonGlowLinearRgb:{value:new THREE.Vector3()},uDaylightStrength:{value:0},
      uTerrain: { value: 1 }, uGround: { value: 1 },
      uViewProjection:{value:new THREE.Matrix4()},
    }, depthTest: false, depthWrite: false }));
    (this.background.material as THREE.ShaderMaterial).uniforms.uMilkyWay!.value.userData.milkyWayPlaceholder=true;
    this.background.frustumCulled = false; this.background.renderOrder = -100; this.scene.add(this.background);
    this.galaxyNear=new THREE.Mesh(this.background.geometry,new THREE.ShaderMaterial({vertexShader:backgroundVertex,fragmentShader:galaxyNearFragment,
      uniforms:(this.background.material as THREE.ShaderMaterial).uniforms,transparent:true,blending:THREE.AdditiveBlending,depthTest:true,depthWrite:false}));
    this.galaxyNear.frustumCulled=false;this.galaxyNear.renderOrder=0;this.galaxyNear.visible=false;this.scene.add(this.galaxyNear);

    const day = this.emptyTexture([18, 40, 60, 255], true), night = this.emptyTexture([0, 0, 0, 255], true), clouds = this.emptyTexture([0, 0, 0, 255], false);
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.ShaderMaterial({ vertexShader: earthVertex, fragmentShader: earthFragment, uniforms: {
      uDay: { value: day }, uNight: { value: night }, uClouds: { value: clouds }, uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uHasDay: { value: 0 }, uHasNight: { value: 0 }, uHasClouds: { value: 0 }, uDayEnabled: { value: 1 }, uNightEnabled: { value: 1 }, uCloudEnabled: { value: 1 },
    } }));
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.012, 64, 48), new THREE.ShaderMaterial({ vertexShader: earthVertex, fragmentShader: atmosphereFragment, uniforms: { uSunDirection: { value: new THREE.Vector3(1, 0, 0) } }, transparent: true, side: THREE.BackSide, depthWrite: false }));
    this.atmosphere.renderOrder = 5;
    this.earthGroup.add(this.earth, this.atmosphere, this.observerMarker); this.scene.add(this.earthGroup);
    this.scene.add(this.horizonPlane); this.horizonPlane.renderOrder = 4;
    for (const id of ['Sun', 'Moon']) {
      const body = new THREE.Mesh(id==='Moon'?new THREE.PlaneGeometry(2,2):this.physicalSunGeometry, new THREE.ShaderMaterial({ vertexShader: observedBodyVertex, fragmentShader: id==='Moon'?moonFragment:bodyFragment, uniforms: {
        ...this.refractionBridge.uniforms,uDiscWarpActive:{value:false},uDiscBoundsNdc:{value:new THREE.Vector4(-1,-1,1,1)},
        uDiscPhysicalBasis:{value:new THREE.Matrix3()},uDiscGeometricCentre:{value:new THREE.Vector3()},uDiscObservedCentreEnu:{value:new THREE.Vector3()},
        uDiscTanRadius:{value:.005},uDiscTeachingScale:{value:1},uDiscCameraRotation:{value:new THREE.Matrix3()},uDiscAspect:{value:1},uDiscTanFov:{value:1},
        uSunDirection: { value: new THREE.Vector3() }, uColor: { value: id === 'Sun' ? new THREE.Color(1, .84, .48) : new THREE.Color(.67, .66, .63) }, uSelfLuminous: { value: id === 'Sun' ? 1 : 0 }, uGround: {value:1}, uTerrain: this.sharedUniforms.uTerrain,uVisibility:{value:1},
        ...(id==='Moon'?{uMoon:{value:this.emptyTexture([160,160,160,255],true)},uHasMoon:{value:0},uDiscToBodyFixed:{value:new THREE.Matrix3()},uDiscToDisplay:{value:new THREE.Matrix3()},uScatterEnabled:{value:0},
          uBackgroundLinearRgb:(this.background.material as THREE.ShaderMaterial).uniforms.uBackgroundLinearRgb!,uHorizonGlowLinearRgb:(this.background.material as THREE.ShaderMaterial).uniforms.uHorizonGlowLinearRgb!}:{}),
      },transparent:true,depthWrite:false }));
      // The unlit lunar hemisphere is an opaque disc and must cover sky points/lines.
      body.visible = false;body.frustumCulled=false;body.renderOrder=id==='Moon'?5:4; this.bodies.set(id, body); this.scene.add(body);
    }
    const moon=this.bodies.get('Moon')!;
    this.loupeMoon=new THREE.Mesh(moon.geometry,moon.material);this.loupeScene.add(this.loupeMoon);

    this.loadTexture(earthDayUrl, true, 'uDay', 'uHasDay');
    this.loadTexture(earthNightUrl, true, 'uNight', 'uHasNight');
    this.loadTexture(earthCloudsUrl, false, 'uClouds', 'uHasClouds');
    this.loadTexture(moonColorUrl,true,'uMoon','uHasMoon',moon.material);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('lostpointercapture',this.onLostPointerCapture);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('keydown', this.onKeyDown);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    window.addEventListener('blur',this.onWindowBlur);document.addEventListener('visibilitychange',this.onVisibilityChange);
    this.resizeObserver = new ResizeObserver(() => { this.resize(); this.onCameraChange(); });
    this.resizeObserver.observe(container); this.resize();
    }catch(error){this.dispose();throw error;}
  }

  private emptyTexture(bytes: number[], srgb: boolean): THREE.DataTexture {
    const texture = new THREE.DataTexture(new Uint8Array(bytes), 1, 1);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; texture.needsUpdate = true;
    this.resources.add(texture); return texture;
  }
  private loadTexture(url: string, srgb: boolean, sampler: string, flag: string,material=this.earth.material): void {
    this.pendingAssets.add(sampler); this.syncAssetStatus();
    if (!url || /^data:[^,]*,\s*$/i.test(url)) {
      this.failAsset(sampler, `贴图为空：${sampler}`); return;
    }
    new THREE.TextureLoader().load(url, texture => {
      if (this.disposed) { texture.dispose(); return; }
      const image = texture.image as { width?: number; height?: number } | undefined;
      if (!(image?.width && image?.height)) { texture.dispose(); this.failAsset(sampler, `贴图解码尺寸无效：${sampler}`); return; }
      texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      this.resources.add(texture); this.loadedTextures.push(texture);
      material.uniforms[sampler]!.value = texture; material.uniforms[flag]!.value = 1;
      this.pendingAssets.delete(sampler); this.loadedAssets.add(sampler); this.assetErrors.delete(sampler); this.syncAssetStatus();
      this.onCameraChange();
    }, undefined, () => {
      this.failAsset(sampler, `贴图加载失败：${sampler}`);
    });
  }
  private failAsset(sampler: string, message: string): void {
    if (this.disposed) return;
    this.pendingAssets.delete(sampler); this.assetErrors.set(sampler, message);
    this.syncAssetStatus(); this.onCameraChange();
  }
  private syncAssetStatus(): void {
    this.container.dataset.assetPending = String(this.pendingAssets.size);
    this.container.dataset.assetLoaded = String(this.loadedAssets.size);
    if (this.assetErrors.size) this.container.dataset.assetWarning = [...this.assetErrors.values()].join('；');
    else delete this.container.dataset.assetWarning;
  }
  getAssetStatus(): { pending: string[]; loaded: string[]; errors: string[] } {
    return { pending: [...this.pendingAssets], loaded: [...this.loadedAssets], errors: [...this.assetErrors.values()] };
  }

  resize(): void {
    this.clearGesture();
    this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight);
    this.budgetClass=renderBudgetClass(this.width,this.height,window.matchMedia('(pointer: coarse)').matches);
    this.baselineRatio = cappedPixelRatio(this.width, this.height, window.devicePixelRatio || 1, this.budgetClass==='mobile');
    this.applyBackingQuality();
    this.labels.resize(this.width, this.height, this.baselineRatio);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
    this.loadMilkyWayTier(this.width<720?'1k':'2k');
  }

  private applyBackingQuality():void {
    this.ratio=this.baselineRatio*this.runtimeQuality.pixelScale;
    this.renderer.setPixelRatio(this.ratio);this.renderer.setSize(this.width,this.height,false);
    this.starMaterial.uniforms.uDpr!.value=this.ratio;
  }
  setRuntimeQuality(quality:Readonly<RuntimeRenderQuality>):void {
    if(this.disposed||sameRuntimeRenderQuality(quality,this.runtimeQuality))return;
    const pixelsChanged=quality.pixelScale!==this.runtimeQuality.pixelScale;
    this.runtimeQuality=Object.freeze({...quality});
    if(pixelsChanged)this.applyBackingQuality();
    this.labels.invalidateLayout();this.onCameraChange();
  }
  getRuntimeQualityCapabilities():Readonly<RuntimeQualityCapabilities>{return WEBGL_RUNTIME_QUALITY_CAPABILITIES;}
  setStageInputEnabled(enabled:boolean):void {this.stageInputEnabled=enabled;if(!enabled)this.clearGesture();}

  private loadMilkyWayTier(tier:'1k'|'2k'):void {
    if(tier===this.requestedMilkyWayTier||this.disposed)return;
    this.requestedMilkyWayTier=tier;const generation=++this.milkyWayGeneration;
    const uniforms=(this.background.material as THREE.ShaderMaterial).uniforms;
    if(this.milkyWayTexture){this.resources.delete(this.milkyWayTexture);this.milkyWayTexture.dispose();this.milkyWayTexture=null;}
    this.milkyWayTier=null;uniforms.uHasMilkyWay!.value=0;
    // A single shared 1px placeholder avoids holding the previous real resolution during decode.
    const placeholder=[...this.resources].find(texture=>texture.userData.milkyWayPlaceholder);
    if(placeholder)uniforms.uMilkyWay!.value=placeholder;
    else {const texture=this.emptyTexture([0,0,0,255],true);texture.userData.milkyWayPlaceholder=true;uniforms.uMilkyWay!.value=texture;}
    this.pendingAssets.add('uMilkyWay');this.loadedAssets.delete('uMilkyWay');this.assetErrors.delete('uMilkyWay');this.syncAssetStatus();
    const url=tier==='1k'?milkyWayMobileUrl:milkyWayDesktopUrl;
    if(!url||/^data:[^,]*,\s*$/i.test(url)){this.failAsset('uMilkyWay','银河贴图为空');return;}
    new THREE.TextureLoader().load(url,texture=>{
      if(this.disposed||generation!==this.milkyWayGeneration){texture.dispose();return;}
      const image=texture.image as {width?:number;height?:number}|undefined;
      if(!(image?.width&&image.height)){texture.dispose();this.failAsset('uMilkyWay','银河贴图解码尺寸无效');return;}
      texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;
      texture.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());texture.userData.assetSlot='uMilkyWay';
      this.resources.add(texture);this.milkyWayTexture=texture;this.milkyWayTier=tier;
      uniforms.uMilkyWay!.value=texture;uniforms.uHasMilkyWay!.value=1;
      this.pendingAssets.delete('uMilkyWay');this.loadedAssets.add('uMilkyWay');this.assetErrors.delete('uMilkyWay');this.syncAssetStatus();this.onCameraChange();
    },undefined,()=>{if(generation===this.milkyWayGeneration)this.failAsset('uMilkyWay','银河贴图加载失败');});
  }

  render(state: SimulationState, snapshot: ScienceSnapshot, appearance:SkyAppearance=deriveSkyAppearance(state,snapshot)): void {
    if (this.disposed||this.contextLost) return;
    if(this.gestureView!==null&&this.gestureView!==state.viewMode)this.clearGesture();
    const start = performance.now();
    this.state = state; this.snapshot = snapshot; this.finite = state.viewMode === 'globe' || state.viewMode === 'horizon';
    this.refractionProfile=getDisplayRefractionProfile(snapshot,state.viewMode);this.refractionBridge.update(this.refractionProfile);
    this.skyAppearance=appearance;
    this.updateStarEpoch(snapshot);
    this.canonicalSelected=resolveObjectDetails(catalog,state.selected,snapshot)?.id??null;
    this.frame = cameraFrameForState(state, snapshot);
    this.sharedUniforms.uFrame.value.copy(matrix3(this.frame));
    this.sharedUniforms.uFinite.value = this.finite ? 1 : 0;
    this.sharedUniforms.uGround.value = state.viewMode === 'ground' ? 1 : 0;
    this.sharedUniforms.uTerrain.value = state.layers.terrain ? 1 : 0;
    this.sharedUniforms.uBackAlpha.value = state.layers.backHemisphere ? .28 : .13;
    this.updateCamera(state);
    this.updateArcs(state,snapshot);this.updateSelection(this.canonicalSelected);
    const sun = snapshot.bodies.find(body => body.id === 'Sun');
    const sunDirection = sun ? asThree(multiplyVector(this.frame, sun.geocentricEqjAU)).normalize() : new THREE.Vector3(1, 0, 0);
    const skyVisibility = appearance.starVisibility;
    this.starMaterial.uniforms.uVisibility!.value = skyVisibility;
    this.starMaterial.uniforms.uLimit!.value = appearance.limitingMagnitude;
    this.constellationLines.visible = state.layers.constellationLines;
    this.selectionLines.visible = !!this.canonicalSelected?.startsWith('constellation:') && this.selectionLines.geometry.drawRange.count>0;
    this.lineMaterial.uniforms.uAlpha!.value = .42 * (state.presentation === 'explanation' ? 1 : Math.max(.03, skyVisibility));
    const background = (this.background.material as THREE.ShaderMaterial).uniforms;
    background.uCameraRotation!.value.setFromMatrix4(this.camera.matrixWorld);
    background.uAspect!.value = this.width / this.height; background.uTanFov!.value = Math.tan(this.camera.fov * RAD / 2);
    background.uFrameInverse!.value.copy(matrix3(transpose(this.frame)));
    background.uMilkyWayEnabled!.value=state.layers.milkyWay?1:0;background.uMilkyWayContrast!.value=appearance.milkyWayContrast;
    background.uBackgroundLinearRgb!.value.copy(asThree(appearance.backgroundLinearRgb));background.uHorizonGlowLinearRgb!.value.copy(asThree(appearance.horizonGlowLinearRgb));
    background.uDaylightStrength!.value=appearance.daylightStrength;
    background.uViewProjection!.value.copy(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);
    this.galaxyNear.visible=this.finite&&state.layers.milkyWay&&background.uHasMilkyWay!.value===1&&appearance.milkyWayContrast>0;
    background.uTerrain!.value = state.layers.terrain ? 1 : 0;
    background.uGround!.value = state.viewMode === 'ground' ? 1 : 0;

    this.earthGroup.visible = state.viewMode !== 'ground';
    this.earthGroup.matrixAutoUpdate = false;
    const earthMatrix = multiplyMatrix(multiplyMatrix(this.frame, snapshot.earthFixedToEqj), transpose(EQJ_TO_THREE));
    this.earthGroup.matrix.copy(matrix4(earthMatrix));
    const earthRadius = this.finite ? .075 : 1;
    this.earthGroup.matrix.scale(new THREE.Vector3(earthRadius, earthRadius, earthRadius));
    this.earth.material.uniforms.uSunDirection!.value.copy(sunDirection);
    this.earth.material.uniforms.uDayEnabled!.value = state.layers.earthDay ? 1 : 0;
    this.earth.material.uniforms.uNightEnabled!.value = state.layers.earthNightLights ? 1 : 0;
    this.earth.material.uniforms.uCloudEnabled!.value = state.layers.earthClouds ? 1 : 0;
    this.atmosphere.material.uniforms.uSunDirection!.value.copy(sunDirection); this.atmosphere.visible = state.layers.atmosphere;
    this.observerMarker.position.copy(asThree(geographicToThree(state.observer.latitudeDeg, state.observer.longitudeDegEast))).multiplyScalar(1.018);
    this.observerMarker.visible = state.layers.horizon;
    let phase=performance.now();this.updateBodies(state, snapshot);this.renderPhases.bodiesMs=performance.now()-phase;
    phase=performance.now();this.updateReferences(state, snapshot);this.renderPhases.referencesMs=performance.now()-phase;
    phase=performance.now();
    this.renderer.info.reset(); this.renderer.setViewport(0,0,this.width,this.height);this.renderer.render(this.scene, this.camera);
    this.renderMoonLoupe();
    this.renderPhases.sceneSubmitMs=performance.now()-phase;phase=performance.now();this.drawLabels(state, snapshot, skyVisibility);this.renderPhases.labelsMs=performance.now()-phase;
    this.frameSamples.push(performance.now() - start); if (this.frameSamples.length > 240) this.frameSamples.shift();
  }

  private updateCamera(state: SimulationState): void {
    if (state.viewMode === 'ground') {
      const c = state.cameras.ground, az = c.azimuthDegNorthEast * RAD, alt = c.altitudeDeg * RAD;
      this.camera.position.set(0, 0, 0); this.camera.up.set(0, 1, 0);
      this.camera.quaternion.setFromEuler(new THREE.Euler(alt,-az,0,'YXZ'));
      this.camera.fov = c.verticalFovDeg;
    } else {
      const c = state.cameras[state.viewMode];
      this.camera.quaternion.fromArray(c.orientationQuaternion).normalize();
      const distance = this.finite ? finiteCameraDistance(c.distanceDisplayUnits,this.width/this.height) : c.distanceDisplayUnits;
      this.camera.position.set(0, 0, distance).applyQuaternion(this.camera.quaternion);
      this.camera.fov = c.verticalFovDeg;
    }
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
  }
  private updateStarEpoch(snapshot: ScienceSnapshot): void {
    // The fixed-source motion and Float32 bounds are documented/tested separately.
    const epoch = cachedStarEpoch(snapshot.utDaysJ2000);
    if (epoch === this.lastStarEpoch) return;
    this.lastStarEpoch = epoch;
    writeStarDirectionBuffer(catalog.stars, epoch, this.starDirections);
    this.arcKnots.updateEpoch(this.starDirections);
    const epochSnapshot={...snapshot,utDaysJ2000:epoch};
    this.constellationDirections.clear();
    for (const c of catalog.constellations) { const direction=resolveObjectDirectionEqj(catalog,`constellation:${c.id}`,epochSnapshot); if(direction) this.constellationDirections.set(c.id,direction); }
  }
  private updateSelection(selected: ObjectId | null): void {
    if (selected === this.lastSelection) return; this.lastSelection = selected;
    this.selectionLines.geometry.setDrawRange(0,0);
    if (selected?.startsWith('constellation:')) {
      const count=writeConstellationHighlight(this.arcBuffer,selected.slice(14));
      this.selectionLines.geometry.index!.needsUpdate=true;this.selectionLines.geometry.setDrawRange(0,count);
    }
  }

  private updateArcs(state:SimulationState,snapshot:ScienceSnapshot):void {
    this.arcUploadBytes=0;
    const key=JSON.stringify([state.viewMode,this.finite,this.lastStarEpoch,this.frame,this.refractionProfile?.key,this.camera.quaternion.toArray(),this.camera.position.toArray(),this.camera.fov,this.width,this.height,state.layers.terrain]);
    if(key===this.lastArcKey)return;this.lastArcKey=key;const start=performance.now();
    const extraKnotsByArc=this.refractionProfile&&!this.refractionProfile.identity?this.arcKnots.update(snapshot.localZenithEqjUnit,this.refractionProfile.geometricHorizonDeg):undefined;
    let phase=performance.now();this.arcPhases.knotsMs=phase-start;
    const rotation=rowsOf(new THREE.Matrix3().setFromMatrix4(this.camera.matrixWorldInverse)),position=this.camera.position.toArray(),tanFov=Math.tan(this.camera.fov*RAD/2),aspect=this.camera.aspect;
    const project=createArcProjector(this.frame,this.refractionProfile!,rotation,position,this.finite,this.width,this.height,tanFov,this.refractionBridge.maximumCorrectionDeg);
    const result=updateSphericalArcBuffer(this.arcBuffer,{maxAngularStepDeg:.5,extraKnotsByArc,screenError:{project,maxErrorPx:.35}});
    this.arcPhases.deriveMs=performance.now()-phase;phase=performance.now();
    const positionAttribute=this.stars.geometry.getAttribute('position') as THREE.BufferAttribute;
    // Compare derived storage and upload bounded changed runs; camera-only updates do not
    // automatically re-upload all 1.14 MiB. Shadows are CPU change detection, not another catalog.
    let positionFirst=-1,positionLast=-1;const positions=this.arcBuffer.positions,shadow=this.arcPositionShadow;
    const compare=(from:number,to:number):void=>{for(let i=from;i<to;i++)if(positions[i]!==shadow[i]){
      if(positionFirst<0)positionFirst=i;positionLast=i;shadow[i]=positions[i]!;
    }};
    if(this.shadowStarEpoch!==this.lastStarEpoch){compare(0,this.arcBuffer.starCount*3);this.shadowStarEpoch=this.lastStarEpoch;}
    // Unused fixed interior slots are neither written by the curve module nor referenced
    // by current indices. If a later arc grows, its newly active slots are compared then.
    for(let arc=0;arc<this.arcBuffer.arcCount;arc++){
      const count=this.arcBuffer.arcSegmentCounts[arc]!;if(count<=1)continue;
      const from=(this.arcBuffer.starCount+arc*(this.arcBuffer.maxSegmentsPerArc-1))*3;compare(from,from+(count-1)*3);
    }
    if(positionFirst>=0){queueBufferUpdate(positionAttribute,positionFirst,positionLast-positionFirst+1);this.arcUploadBytes+=(positionLast-positionFirst+1)*4;}
    const indexAttribute=this.constellationLines.geometry.index!;let first=-1,last=-1;
    for(let i=0;i<result.indexCount;i++)if(this.arcBuffer.ordinaryIndex[i]!==this.arcIndexShadow[i]){if(first<0)first=i;last=i;this.arcIndexShadow[i]=this.arcBuffer.ordinaryIndex[i]!;}
    if(first>=0){queueBufferUpdate(indexAttribute,first,last-first+1);this.arcUploadBytes+=(last-first+1)*4;}
    this.constellationLines.geometry.setDrawRange(0,result.indexCount);this.arcUpdateCount++;this.arcPhases.changeDetectionMs=performance.now()-phase;this.arcUpdateMs=performance.now()-start;this.arcUploadBytesTotal+=this.arcUploadBytes;
    this.lastSelection=undefined;
  }

  private displayVector(eqj:Vec3,localReference=false):THREE.Vector3 {
    return asThree(this.refractionProfile?displayDirection(eqj,this.frame,this.refractionProfile,localReference):multiplyVector(this.frame,eqj)).normalize();
  }

  changeReferenceLock(state:SimulationState,snapshot:ScienceSnapshot,previousLock:ReferenceLock):void {
    this.clearGesture();
    changeReferenceLockCamera(state,snapshot,previousLock);this.lastReferenceKey='';this.labels.invalidateLayout();this.onCameraChange();
  }
  focusSelection(state:SimulationState,snapshot:ScienceSnapshot):boolean {
    this.clearGesture();
    const details=resolveObjectDetails(catalog,state.selected,snapshot);
    if(details?.kind==='constellation')this.updateStarEpoch(snapshot);
    const direction=details?.kind==='constellation'?this.constellationDirections.get(details.id.slice(14))??null:resolveDisplayDirectionEqj(catalog,state.selected,snapshot,state.viewMode);
    if(!direction) return false;
    const profile=getDisplayRefractionProfile(snapshot,state.viewMode),frame=cameraFrameForState(state,snapshot);
    const cameraDirection=profile.identity?direction:multiplyVector(transpose(frame),displayDirection(direction,frame,profile));
    focusDirectionCamera(state,snapshot,cameraDirection);this.labels.invalidateLayout();this.onCameraChange();return true;
  }
  private updateBodies(state: SimulationState, snapshot: ScienceSnapshot): void {
    this.groundDiscs.clear();
    this.lunarAppearance=resolveLunarAppearance(snapshot,state.viewMode);this.lunarTransform=null;this.mainUnmagnifiedMoonDiameter=0;
    for (const [id, mesh] of this.bodies) {
      const body = snapshot.bodies.find(body => body.id === id);
      mesh.material.uniforms.uDiscWarpActive!.value=false;
      if(id==='Sun')mesh.geometry=this.physicalSunGeometry;
      mesh.visible = !!body && state.layers.sunMoon;
      if (!body) continue;
      const eqj = state.viewMode === 'ground' ? body.topocentricDirectionEqj : body.geocentricEqjAU;
      const direction = asThree(multiplyVector(this.frame, eqj)).normalize();
      const appearance=id==='Moon'?this.lunarAppearance:null;
      const diameter=appearance?.angularDiameterDeg??body.angularDiameterDeg;
      const distance = this.finite ? 1 : 100;
      mesh.position.copy(direction).multiplyScalar(distance);
      if (!this.finite) mesh.position.add(this.camera.position);
      const radius=Math.tan(diameter*RAD/2)*distance;
      const scale = state.presentation === 'explanation' ? state.illustration.bodySizeScale : 1;
      mesh.scale.setScalar(radius*scale);
      mesh.material.uniforms.uGround!.value=state.viewMode==='ground'?1:0;
      if(id==='Moon')mesh.material.uniforms.uScatterEnabled!.value=state.viewMode==='ground'&&state.layers.atmosphere?1:0;
      if(appearance){
        const cameraUp=new THREE.Vector3(0,1,0).applyQuaternion(this.camera.quaternion);
        const eye=this.camera.position.clone().sub(mesh.position).normalize();
        this.lunarTransform=lunarDiscTransform(appearance,this.frame,cameraUp.toArray(),eye.toArray());
        mesh.quaternion.setFromRotationMatrix(matrix4(this.lunarTransform.displayBasis));
        mesh.material.uniforms.uDiscToBodyFixed!.value.copy(matrix3(this.lunarTransform.discToBodyFixed));
        mesh.material.uniforms.uDiscToDisplay!.value.copy(matrix3(this.lunarTransform.displayBasis));
        mesh.material.uniforms.uSunDirection!.value.copy(asThree(this.lunarTransform.sunDirectionDisplay));
        this.mainUnmagnifiedMoonDiameter=this.projectedBodyRadius(mesh,radius)*2;
        this.loupeMoon.quaternion.copy(mesh.quaternion);
        this.loupeCamera.position.copy(eye).multiplyScalar(20);
        const basis=this.lunarTransform.displayBasis;
        this.loupeCamera.up.set(basis[0][1],basis[1][1],basis[2][1]);this.loupeCamera.lookAt(0,0,0);this.loupeCamera.updateMatrixWorld(true);
      }else{
        if (body.bodyFixedToEqj) mesh.quaternion.setFromRotationMatrix(matrix4(multiplyMatrix(multiplyMatrix(this.frame, body.bodyFixedToEqj), transpose(EQJ_TO_THREE))));
        mesh.material.uniforms.uSunDirection!.value.copy(body.bodyToSunEqjUnit ? asThree(multiplyVector(this.frame, body.bodyToSunEqjUnit)).normalize() : direction);
      }
      if(state.viewMode==='ground'&&this.refractionProfile&&!this.refractionProfile.identity){
        const cameraUp=new THREE.Vector3(0,1,0).applyQuaternion(this.camera.quaternion);
        const basis=id==='Moon'&&this.lunarTransform?this.lunarTransform.displayBasis:observationBasis(direction.clone().negate().toArray(),cameraUp.toArray());
        const disc=createRefractedDisc(basis,direction.toArray(),Math.tan(diameter*RAD/2),scale,this.refractionProfile);
        const bounds=refractedDiscBounds(disc,rowsOf(new THREE.Matrix3().setFromMatrix4(this.camera.matrixWorldInverse)),this.camera.aspect,Math.tan(this.camera.fov*RAD/2),[2/this.width,2/this.height]);
        this.groundDiscs.set(id,{disc,bounds});
        const uniforms=mesh.material.uniforms;uniforms.uDiscWarpActive!.value=true;
        if(id==='Sun')mesh.geometry=this.bodies.get('Moon')!.geometry;
        uniforms.uDiscBoundsNdc!.value.set(...(bounds??[-1,-1,-1,-1]));
        uniforms.uDiscPhysicalBasis!.value.copy(matrix3(basis));uniforms.uDiscGeometricCentre!.value.copy(direction);
        uniforms.uDiscObservedCentreEnu!.value.set(...disc.observedCentreEnu);
        uniforms.uDiscTanRadius!.value=disc.physicalTanRadius;uniforms.uDiscTeachingScale!.value=scale;
        uniforms.uDiscCameraRotation!.value.setFromMatrix4(this.camera.matrixWorld);uniforms.uDiscAspect!.value=this.camera.aspect;uniforms.uDiscTanFov!.value=Math.tan(this.camera.fov*RAD/2);
        if(!bounds)mesh.visible=false;
      }
      const facing=this.finite?sphereFacing(direction.toArray(),this.camera.position.toArray()):1;
      if(this.finite&&facing<=0&&!state.layers.backHemisphere){mesh.visible=false;continue;}
      const rim=this.finite?THREE.MathUtils.lerp(.22,1,THREE.MathUtils.smoothstep(Math.abs(facing),.015,.35)):1;
      mesh.material.uniforms.uVisibility!.value=(facing<=0?.28:1)*rim;
      if (state.viewMode === 'ground' && !this.groundDiscs.has(id)&&state.layers.terrain && direction.y + Math.sin(diameter * RAD / 2) < hillHeight(direction)) mesh.visible = false;
    }
  }

  /** Projects the same sphere silhouette used by drawing, including finite shell distance and teaching scale. */
  private projectedBodyRadius(mesh:THREE.Mesh,radius=mesh.scale.x):number {
    const distance=this.camera.position.distanceTo(mesh.position);
    if(!(distance>radius))return Math.max(this.width,this.height);
    const eye=this.camera.position.clone().sub(mesh.position).normalize(),up=new THREE.Vector3(0,1,0).applyQuaternion(this.camera.quaternion);
    const basis=observationBasis(eye.toArray(),up.toArray()),right=new THREE.Vector3(basis[0][0],basis[1][0],basis[2][0]),tangentUp=new THREE.Vector3(basis[0][1],basis[1][1],basis[2][1]);
    const disc=mesh.geometry instanceof THREE.PlaneGeometry;
    const center=mesh.position.clone().addScaledVector(eye,disc?0:radius*radius/distance),tangentRadius=disc?radius:radius*Math.sqrt(1-radius*radius/(distance*distance));
    const projected=mesh.position.clone().project(this.camera);let max=0;
    for(let i=0;i<16;i++){const angle=i*Math.PI/8,p=center.clone().addScaledVector(right,Math.cos(angle)*tangentRadius).addScaledVector(tangentUp,Math.sin(angle)*tangentRadius).project(this.camera);max=Math.max(max,Math.hypot((p.x-projected.x)*this.width/2,(p.y-projected.y)*this.height/2));}
    return Number.isFinite(max)?max:0;
  }

  setMoonLoupeViewport(rect:DOMRect|null):void {
    const next=rect&&rect.width>0&&rect.height>0?{left:rect.left,top:rect.top,width:rect.width,height:rect.height}:null;
    if(JSON.stringify(next)!==JSON.stringify(this.loupeViewport))this.labels.invalidateLayout();
    this.loupeViewport=next;
  }
  getMoonLoupeDiagnostics(){
    const appearance=this.lunarAppearance,transform=this.lunarTransform,moon=this.bodies.get('Moon')!;
    const status:'pending'|'ready'|'error'=this.assetErrors.has('uMoon')?'error':this.loadedAssets.has('uMoon')&&appearance&&transform?'ready':'pending';
    const basis=transform?.displayBasis,sun=transform?.sunDirectionDisplay;
    const lensRight:Vec3=basis?[basis[0][0],basis[1][0],basis[2][0]]:[1,0,0],lensUp:Vec3=basis?[basis[0][1],basis[1][1],basis[2][1]]:[0,1,0],eye:Vec3=basis?[basis[0][2],basis[1][2],basis[2][2]]:[0,0,1];
    const centredDiameter=appearance?unmagnifiedDiscDiameter(Math.tan(appearance.angularDiameterDeg*RAD/2),1,this.camera.fov,this.height):0;
    const moonDirection=appearance?.observerDirectionEqjUnit.map(v=>-v) as Vec3|undefined;
    const mainVisible=!!(moonDirection&&this.state&&this.projectDirection(moonDirection,this.state));
    const centerCamera=moon.position.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const solarTangent=sun?asThree(sun).addScaledVector(asThree(eye),-asThree(sun).dot(asThree(eye))):null;
    const tangentCamera=solarTangent?.applyQuaternion(this.camera.quaternion.clone().invert());
    const warped=this.groundDiscs.get('Moon');let mainLimb=tangentCamera?perspectiveTangentScreenUnit(centerCamera.toArray(),tangentCamera.toArray()):null;
    if(warped&&sun){
      const b=warped.disc.physicalBasisDisplay,s=asThree(sun),right=new THREE.Vector3(b[0][0],b[1][0],b[2][0]),up=new THREE.Vector3(b[0][1],b[1][1],b[2][1]);
      const sx=s.dot(right),sy=s.dot(up),length=Math.hypot(sx,sy);
      const camera=rowsOf(new THREE.Matrix3().setFromMatrix4(this.camera.matrixWorldInverse));
      const p0=length>1e-10?projectDiscRay(discDisplayRay(-.001*sx/length,-.001*sy/length,warped.disc),camera,this.camera.aspect,Math.tan(this.camera.fov*RAD/2)):null;
      const p1=length>1e-10?projectDiscRay(discDisplayRay(.001*sx/length,.001*sy/length,warped.disc),camera,this.camera.aspect,Math.tan(this.camera.fov*RAD/2)):null;
      const dx=p0&&p1?(p1[0]-p0[0])*this.width:0,dy=p0&&p1?(p1[1]-p0[1])*this.height:0;
      mainLimb=p0&&p1&&Math.hypot(dx,dy)>1e-12?[dx/Math.hypot(dx,dy),dy/Math.hypot(dx,dy)]:null;
    }
    return {status,open:!!this.loupeViewport,utDaysJ2000:appearance?.utDaysJ2000??null,perspective:appearance?.perspective??null,
      illuminatedFraction:appearance?.illuminatedFraction??null,angularDiameterDeg:appearance?.angularDiameterDeg??null,
      bodyFixedToEqj:appearance?.bodyFixedToEqj??null,sunDirectionEqjUnit:appearance?.sunDirectionEqjUnit??null,observerDirectionEqjUnit:appearance?.observerDirectionEqjUnit??null,
      scienceToDisplayBasis:transform?.scienceToDisplayBasis??null,
      mainBrightLimbScreenUnit:mainLimb,loupeBrightLimbScreenUnit:sun?brightLimbScreenUnit(sun,lensRight,lensUp):null,
      brightLimbScreenReference:'CSS x向右、y向上；主图为盘心处实际display映射和透视切向投影，放大镜为未折射正交科学盘。',
      mainDiscRefractionApplied:!!warped,loupeRefractionApplied:false,refraction:this.refractionBridge.getDiagnostics(),
      mainMoonPositionDisplay:moon.position.toArray(),mainCameraPositionDisplay:this.camera.position.toArray(),mainCameraOrientationQuaternion:this.camera.quaternion.toArray(),mainViewportCssSize:[this.width,this.height],
      displayBasis:transform?.displayBasis??null,
      mainUnmagnifiedDiameterCssPx:mainVisible?this.mainUnmagnifiedMoonDiameter:null,loupeDiameterCssPx:this.loupeDiameter,
      viewportCentrePhysicalDiameterCssPx:centredDiameter,magnificationBasis:'viewport-centre-angular-scale' as const,
      magnificationRelativeToMain:centredDiameter>0&&this.loupeViewport?Math.min(this.loupeViewport.width,this.loupeViewport.height)/1.28/centredDiameter:null,
      orientationLabel:`盘面朝向随当前视野上方 · ${appearance?.perspective==='topocentric'?'站心':'地心'}`,
      viewportCssRect:this.loupeViewport,sharedMaterialId:moon.material.uuid,textureLoaded:this.loadedAssets.has('uMoon'),
      mainMoonMaterialId:moon.material.uuid,loupeMoonMaterialId:this.loupeMoon.material.uuid,mainMoonGeometryId:moon.geometry.uuid,loupeMoonGeometryId:this.loupeMoon.geometry.uuid,
      errorMessage:this.assetErrors.get('uMoon')??null};
  }
  private renderMoonLoupe():void {
    this.loupeDiameter=0;
    if(!this.loupeViewport||this.getMoonLoupeDiagnostics().status!=='ready')return;
    const bounds=this.canvas.getBoundingClientRect(),rect=this.loupeViewport;
    const side=Math.min(rect.width,rect.height),x=rect.left-bounds.left+(rect.width-side)/2,y=this.height-(rect.top-bounds.top+(rect.height+side)/2);
    if(x<0||y<0||x+side>this.width||y+side>this.height)return;
    const material=this.loupeMoon.material,ground=material.uniforms.uGround!.value,visibility=material.uniforms.uVisibility!.value,warp=material.uniforms.uDiscWarpActive!.value;
    const clear=this.renderer.getClearColor(new THREE.Color()),clearAlpha=this.renderer.getClearAlpha();
    this.renderer.setScissorTest(true);this.renderer.setScissor(x,y,side,side);this.renderer.setViewport(x,y,side,side);
    this.renderer.setClearColor(0x000000,1);this.renderer.clear(true,true,false);
    material.uniforms.uGround!.value=0;material.uniforms.uVisibility!.value=1;material.uniforms.uDiscWarpActive!.value=false;
    this.renderer.render(this.loupeScene,this.loupeCamera);
    material.uniforms.uGround!.value=ground;material.uniforms.uVisibility!.value=visibility;material.uniforms.uDiscWarpActive!.value=warp;
    this.renderer.setScissorTest(false);this.renderer.setViewport(0,0,this.width,this.height);this.renderer.setClearColor(clear,clearAlpha);
    this.loupeDiameter=side/1.28;
  }

  private updateReferences(state: SimulationState, snapshot: ScienceSnapshot): void {
    const key = `${snapshot.requestId}:${state.viewMode}:${state.viewMode==='ground'?'horizontal':state.cameras[state.viewMode].referenceLock}:${JSON.stringify([state.layers.ecliptic, state.layers.celestialEquator, state.layers.celestialPoles, state.layers.horizon, state.layers.meridian])}`;
    if (key === this.lastReferenceKey) return; this.lastReferenceKey = key;
    let offset = 0;
    const segment = (a: Vec3, b: Vec3, color: Vec3,celestial=true): void => {
      if (offset + 6 > this.referencePositions.length) return;
      this.referencePositions[offset]=a[0];this.referencePositions[offset+1]=a[1];this.referencePositions[offset+2]=a[2];
      this.referencePositions[offset+3]=b[0];this.referencePositions[offset+4]=b[1];this.referencePositions[offset+5]=b[2];
      this.referenceColors[offset]=color[0];this.referenceColors[offset+1]=color[1];this.referenceColors[offset+2]=color[2];
      this.referenceColors[offset+3]=color[0];this.referenceColors[offset+4]=color[1];this.referenceColors[offset+5]=color[2];
      this.referenceClasses[offset/3]=this.referenceClasses[offset/3+1]=celestial?1:0;offset += 6;
    };
    const circle = (x: Vec3, y: Vec3, color: Vec3,celestial=true): void => {
      const point = (index: number): Vec3 => [x[0] * referenceCos[index]! + y[0] * referenceSin[index]!, x[1] * referenceCos[index]! + y[1] * referenceSin[index]!, x[2] * referenceCos[index]! + y[2] * referenceSin[index]!];
      const thresholds=[-1,this.refractionProfile?.geometricHorizonDeg??0],thresholdSines=thresholds.map(h=>Math.sin(h*RAD)),up=snapshot.localZenithEqjUnit;
      let a=point(0);
      for (let i = 0; i < 720; i++) {
        const b=point(i+1),altitudeA=a[0]*up[0]+a[1]*up[1]+a[2]*up[2],altitudeB=b[0]*up[0]+b[1]*up[1]+b[2]*up[2];
        const low=Math.min(altitudeA,altitudeB)-referenceAltitudeGuard,high=Math.max(altitudeA,altitudeB)+referenceAltitudeGuard;
        const candidate=celestial&&this.refractionProfile&&!this.refractionProfile.identity&&thresholdSines.some(value=>value>=low&&value<=high);
        const sampler=candidate?createMinorArcSampler(a,b):null;
        const knots=sampler?thresholds.flatMap(alt=>minorArcAltitudeCrossings(sampler,up,alt)).sort((a,b)=>a-b):[];
        let previous=a;for(const t of knots){const next=minorArcDirectionAt(sampler!,t);segment(previous,next,color,celestial);previous=next;}
        segment(previous,b,color,celestial);a=b;
      }
    };
    if (state.layers.ecliptic) circle(multiplyVector(snapshot.eclipticOfDateToEqj,[1,0,0]),multiplyVector(snapshot.eclipticOfDateToEqj,[0,1,0]), [.48, .36, .16]);
    const ex = multiplyVector(snapshot.earthFixedToEqj, [1, 0, 0]), ey = multiplyVector(snapshot.earthFixedToEqj, [0, 1, 0]);
    if (state.layers.celestialEquator) circle(ex, ey, [.17, .30, .43]);
    const [east, north, up] = snapshot.eqjToHorizontalGeometric;
    if (state.layers.horizon) circle(east, north, [.15, .36, .27],false);
    if (state.layers.meridian) circle(north, up, [.27, .32, .34],false);
    if (this.finite && state.layers.celestialPoles) {
      const pole = multiplyVector(snapshot.earthFixedToEqj, [0, 0, 1]);
      segment(pole.map(v => v * -1.04) as unknown as Vec3, pole.map(v => v * 1.04) as unknown as Vec3, [.26, .39, .49]);
    }
    if (state.viewMode === 'horizon' && state.layers.horizon) segment(up.map(v => v * -1.03) as unknown as Vec3, up.map(v => v * 1.03) as unknown as Vec3, [.62, .25, .20]);
    this.referenceLines.geometry.getAttribute('position').needsUpdate = true; this.referenceLines.geometry.getAttribute('lineColor').needsUpdate = true;this.referenceLines.geometry.getAttribute('refractionClass').needsUpdate=true;
    this.referenceLines.geometry.setDrawRange(0, offset / 3); this.referenceLines.visible = offset > 0;
    this.horizonPlane.visible = state.viewMode === 'horizon' && state.layers.horizon;
    if (this.horizonPlane.visible) this.horizonPlane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), asThree(multiplyVector(this.frame, snapshot.localZenithEqjUnit)).normalize());
  }

  private projectDirection(eqj: Vec3, state: SimulationState, ignoreTerrain = false, referenceDirection = false): { x: number; y: number; direction: THREE.Vector3; alpha: number;facing:number } | null {
    const direction = this.displayVector(eqj,referenceDirection&&ignoreTerrain);
    if (!ignoreTerrain && state.viewMode === 'ground' && state.layers.terrain && direction.y < hillHeight(direction)) return null;
    const facing=this.finite?sphereFacing(direction.toArray(),this.camera.position.toArray()):1;
    const back = this.finite && facing <= 0;
    if (back && !state.layers.backHemisphere && !referenceDirection) return null;
    const world = direction.clone().multiplyScalar(this.finite ? 1 : 100);
    if (!this.finite) world.add(this.camera.position);
    const rayDirection = world.clone().sub(this.camera.position).normalize();
    if (state.viewMode !== 'ground' && rayHitsSphere(this.camera.position.toArray(), rayDirection.toArray(), this.finite ? .075 : 1, this.finite ? world.distanceTo(this.camera.position) : Infinity)) return null;
    const cameraPoint = world.clone().applyMatrix4(this.camera.matrixWorldInverse);
    if (cameraPoint.z >= 0) return null;
    const projected = world.project(this.camera);
    if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || projected.z > 1) return null;
    const rim=this.finite?THREE.MathUtils.lerp(.22,1,THREE.MathUtils.smoothstep(Math.abs(facing),.015,.35)):1;
    return { x: (projected.x + 1) * this.width / 2, y: (1 - projected.y) * this.height / 2, direction, alpha: (back ? .28 : 1)*rim,facing };
  }

  private drawLabels(state: SimulationState, snapshot: ScienceSnapshot, skyVisibility: number): void {
    const candidates: LabelCandidate[] = []; this.projectedStars = [];this.projectedBodies=[];this.selectedLabelAnchorPixel=null;this.selectionMarkerPixel=null;
    this.qualityBackLabelsSkipped=0;this.qualitySecondaryLabelsOmitted=0;
    const secondary=(id:string,selected:boolean,value:string|undefined):string|undefined=>{
      const result=runtimeLabelSecondary({id,selected},value,this.runtimeQuality);if(value&&!result)this.qualitySecondaryLabelsOmitted++;return result;
    };
    const add = (id: string, text: string, eqj: Vec3, priority: number, secondary?: string, color?: string): void => {
      const p = this.projectDirection(eqj, state, id.startsWith('direction:'), id.startsWith('pole:') || id.startsWith('direction:')); if (!p) return;
      const selected=this.canonicalSelected===id;
      if(runtimeLabelIsHiddenBack({id,selected},p.facing,this.finite,this.runtimeQuality)){this.qualityBackLabelsSkipped++;return;}
      if(this.finite&&!selected&&!id.startsWith('direction:')&&!id.startsWith('pole:')&&Math.abs(p.facing)<.16) return;
      const effectiveSecondary=runtimeLabelSecondary({id,selected},secondary,this.runtimeQuality);if(secondary&&!effectiveSecondary)this.qualitySecondaryLabelsOmitted++;
      candidates.push({ id, text, secondary:effectiveSecondary, x: p.x, y: p.y, priority:priority+(this.finite?p.facing*2:0), color, alpha: selected?Math.max(.6,p.alpha):p.alpha, selected });
      if(selected)this.selectedLabelAnchorPixel={x:p.x,y:p.y};
    };
    const limit = this.starMaterial.uniforms.uLimit!.value as number;
    for (const star of catalog.stars) {
      const selected = this.canonicalSelected === star.id;
      if(!selected&&(!state.layers.brightStarNamesZh||!star.nameZh||star.magnitude>=3.5||star.magnitude>limit||skyVisibility<.05)) continue;
      const eqj: Vec3 = [this.starDirections[star.index * 3]!, this.starDirections[star.index * 3 + 1]!, this.starDirections[star.index * 3 + 2]!];
      const p = this.projectDirection(eqj, state); if (!p) continue;
      this.projectedStars.push({ id: star.id, x: p.x, y: p.y, magnitude: star.magnitude });
      if (selected || state.layers.brightStarNamesZh && star.nameZh && star.magnitude < 3.5) {
        if(runtimeLabelIsHiddenBack({id:star.id,selected},p.facing,this.finite,this.runtimeQuality)){this.qualityBackLabelsSkipped++;continue;}
        if(this.finite&&!selected&&Math.abs(p.facing)<.16) continue;
        candidates.push({ id: star.id, text: star.nameZh || star.nameEn || star.id.toUpperCase(), secondary: secondary(star.id,selected,state.layers.secondaryNames ? star.nameEn : undefined), x: p.x, y: p.y, priority: selected ? 100 : 35 - star.magnitude, color: selected ? '#c8dfed' : '#b8bdc0', alpha: selected?Math.max(.6,p.alpha):p.alpha, selected });
        if(selected)this.selectedLabelAnchorPixel={x:p.x,y:p.y};
      }
    }
    for (const c of catalog.constellations) {
      const selected=this.canonicalSelected===`constellation:${c.id}`;
      const direction=this.constellationDirections.get(c.id);
      if(direction&&(selected||state.layers.constellationLabels&&(skyVisibility>.1||state.presentation==='explanation'))) add(`constellation:${c.id}`, c.nameZh, direction, selected ? 100 : 45, state.layers.secondaryNames ? c.nameEn : undefined,selected?'#c8dfed':undefined);
    }
    for (const body of snapshot.bodies.filter(body => body.id === 'Sun' || body.id === 'Moon')) {
      const id=`body:${body.id}` as ObjectId,direction=resolveDisplayDirectionEqj(catalog,id,snapshot,state.viewMode)!;
      const projected=this.projectDirection(direction,state);
      const mesh=this.bodies.get(body.id);
      if(projected&&state.layers.sunMoon&&mesh?.visible){
        const bounds=this.groundDiscs.get(body.id)?.bounds;
        const radius=bounds?Math.max(Math.abs((bounds[0]+1)*this.width/2-projected.x),Math.abs((bounds[2]+1)*this.width/2-projected.x),Math.abs((1-bounds[1])*this.height/2-projected.y),Math.abs((1-bounds[3])*this.height/2-projected.y)):this.projectedBodyRadius(mesh);
        this.projectedBodies.push({id,x:projected.x,y:projected.y,radius:Math.max(8,radius)});
      }
      if(state.layers.sunMoon||this.canonicalSelected===id) add(id,body.id === 'Sun' ? '太阳' : '月亮',direction,this.canonicalSelected===id?100:80,undefined,this.canonicalSelected===id?'#c8dfed':body.id === 'Sun' ? '#d3b575' : '#d6dce0');
    }
    if (state.layers.horizon) {
      const [east, north, up] = snapshot.eqjToHorizontalGeometric;
      add('direction:N', '北', north, 90, undefined, '#b5c6d9');
      add('direction:E', '东', east, 90, undefined, '#d3b575');
      add('direction:S', '南', north.map(v => -v) as unknown as Vec3, 90, undefined, '#d57c72');
      add('direction:W', '西', east.map(v => -v) as unknown as Vec3, 90, undefined, '#b5c6d9');
      if (state.viewMode === 'horizon') { add('direction:Z', '天顶', up, 90, undefined, '#d57c72'); add('direction:Z-', '天底', up.map(v => -v) as unknown as Vec3, 90, undefined, '#d57c72'); }
    }
    if (state.layers.celestialPoles) {
      const pole = multiplyVector(snapshot.earthFixedToEqj, [0, 0, 1]);
      add('pole:N', '北天极', pole, 88, undefined, '#9dbad2');
      if (this.finite) add('pole:S', '南天极', pole.map(v => -v) as unknown as Vec3, 88, undefined, '#9dbad2');
    }
    const baseBudget=this.budgetClass==='mobile' ? (state.density==='reference'?24:18) : state.density==='reference'?60:40;
    this.labels.draw(candidates, state.density === 'reference',baseBudget,runtimeOrdinaryLabelBudget(baseBudget,this.runtimeQuality));
    const selectedDirection=this.canonicalSelected?.startsWith('constellation:')?this.constellationDirections.get(this.canonicalSelected.slice(14))??null:resolveDisplayDirectionEqj(catalog,this.canonicalSelected,snapshot,state.viewMode);
    const selected=selectedDirection?this.projectDirection(selectedDirection,state):null;
    if (selected) {
      this.selectionMarkerPixel={x:selected.x,y:selected.y};
      const context = this.labels.canvas.getContext('2d')!; context.strokeStyle = '#c8dfed'; context.lineWidth = 1;
      context.beginPath(); context.arc(selected.x, selected.y, 7, 0, Math.PI * 2); context.stroke();
    }
  }

  getInteractionDiagnostics() {
    const state=this.state,snapshot=this.snapshot;
    const selectedStar=state?.selected?resolveCatalogStar(catalog,state.selected):null;
    const cachedDirection:Vec3|null=selectedStar&&Number.isFinite(this.lastStarEpoch)?[this.starDirections[selectedStar.index*3]!,this.starDirections[selectedStar.index*3+1]!,this.starDirections[selectedStar.index*3+2]!]:null;
    const cachedPixel=state&&cachedDirection?this.projectDirection(cachedDirection,state):null;
    const direction=state&&snapshot?resolveDisplayDirectionEqj(catalog,state.selected,snapshot,state.viewMode):null;
    const markerDirection=this.canonicalSelected?.startsWith('constellation:')?this.constellationDirections.get(this.canonicalSelected.slice(14))??null:direction;
    const display=markerDirection?this.displayVector(markerDirection):null;
    const project=(eqj:Vec3|null):[number,number]|null=>{if(!eqj)return null;const target=this.displayVector(eqj).multiplyScalar(this.finite?1:100);if(!this.finite)target.add(this.camera.position);const cameraPoint=target.clone().applyMatrix4(this.camera.matrixWorldInverse);if(cameraPoint.z>=0)return null;const p=target.project(this.camera);return[p.x,p.y];};
    const projected=project(direction),markerProjected=project(markerDirection);
    const forward=new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion);
    const visible=!!(state&&markerDirection&&this.projectDirection(markerDirection,state));
    const cache=this.labels.getCacheMetrics();
    return {selectedId:state?.selected??null,canonicalSelectedId:this.canonicalSelected,selectedProjectedNdc:projected,selectedDirectionEqj:direction,
      selectedDirectionUtDaysJ2000:snapshot?.utDaysJ2000??null,selectedMarkerDirectionEqj:markerDirection,selectedMarkerProjectedNdc:markerProjected,
      selectedMarkerUtDaysJ2000:this.canonicalSelected?.startsWith('constellation:')?this.lastStarEpoch:snapshot?.utDaysJ2000??null,
      selectedLabelAnchorPixel:this.selectedLabelAnchorPixel?{...this.selectedLabelAnchorPixel}:null,selectionMarkerPixel:this.selectionMarkerPixel?{...this.selectionMarkerPixel}:null,
      selectedOnNearHemisphere:this.finite&&display?sphereFacing(display.toArray(),this.camera.position.toArray())>0:null,selectedVisible:visible,
      highlightedConstellationIds:this.selectionLines.visible&&this.canonicalSelected?.startsWith('constellation:')?[this.canonicalSelected.slice(14)]:[],
      viewForwardEqj:multiplyVector(transpose(this.frame),this.refractionProfile?geometricDisplayRay(forward.toArray(),this.refractionProfile):forward.toArray()),cameraOrientationQuaternion:this.camera.quaternion.toArray(),finiteSphereRadius:this.finite?1:null,
      refraction:this.refractionBridge.getDiagnostics(),sphericalArcs:{...this.arcBuffer.result,positionBytes:this.arcBuffer.positions.byteLength,indexBytes:this.arcBuffer.ordinaryIndex.byteLength,highlightIndexBytes:this.arcBuffer.highlightIndex.byteLength,
        updateCount:this.arcUpdateCount,lastUpdateMs:this.arcUpdateMs,lastUpdatePhases:{...this.arcPhases},requestedUploadBytesLastRender:this.arcUploadBytes,requestedUploadBytesTotal:this.arcUploadBytesTotal,
        cpuChangeDetectionBytes:this.arcPositionShadow.byteLength+this.arcIndexShadow.byteLength,uploadScope:'attribute update ranges; initial GPU allocation uploads full capacity; driver transfer overhead unmeasured'},
      renderPhases:{...this.renderPhases},
      pendingBufferUpdates:{positions:(this.stars.geometry.getAttribute('position') as THREE.BufferAttribute).updateRanges.map(range=>({...range})),ordinaryIndices:this.constellationLines.geometry.index!.updateRanges.map(range=>({...range}))},
      labelHitBoxes:this.labels.getVisibleHitBoxes(),labelOcclusionRects:this.labels.getBlockedRects(),labelCache:cache,labelRasterBytesTotal:cache.labelRasterBytesTotal,cameraPositionDisplay:this.camera.position.toArray(),
      highlightGeometryId:this.selectionLines.geometry.uuid,highlightIndexAttributeId:this.referenceId(this.selectionLines.geometry.index!),highlightPositionAttributeIsShared:this.selectionLines.geometry.getAttribute('position')===this.stars.geometry.getAttribute('position'),
      highlightDrawRangeCount:this.selectionLines.geometry.drawRange.count,
      bodyHitTargets:this.projectedBodies.map(body=>({...body})),
      bodyPickPolicy:{warped:'inverse-ray physical circular mask; conservative bounds are not the mask',warpedHaloCssPx:4,legacyMinimumRadiusCssPx:8},
      groundBodyDiscs:[...this.groundDiscs].map(([id,{disc,bounds}])=>({id,physicalBasisDisplay:disc.physicalBasisDisplay,geometricCentreDisplay:disc.geometricCentreDisplay,
        observedCentreEnu:disc.observedCentreEnu,physicalTanRadius:disc.physicalTanRadius,teachingScale:disc.teachingScale,conservativeBoundsNdc:bounds,
        cameraOrientationQuaternion:this.camera.quaternion.toArray(),verticalFovDeg:this.camera.fov,viewportCssSize:[this.width,this.height],profileKey:disc.profile.key,
        shaderWarpActive:this.bodies.get(id)!.material.uniforms.uDiscWarpActive!.value,meshVisible:this.bodies.get(id)!.visible})),
      starMotion:{consumerModelVersion:ASTROMETRY_MODEL_VERSION,selectedModel:selectedStar?deriveStarMotionModel(selectedStar):null,
        cachedUtDaysJ2000:Number.isFinite(this.lastStarEpoch)?this.lastStarEpoch:null,snapshotUtDaysJ2000:snapshot?.utDaysJ2000??null,cacheStepDays:STAR_CACHE_STEP_DAYS,
        cachedSelectedDirectionEqj:cachedDirection,cachedSelectedPixel:cachedPixel?{x:cachedPixel.x,y:cachedPixel.y}:null,
        positionAttributeId:this.referenceId(this.stars.geometry.getAttribute('position')),positionAttributeVersion:(this.stars.geometry.getAttribute('position') as THREE.BufferAttribute).version,
        pointLinePositionShared:this.constellationLines.geometry.getAttribute('position')===this.stars.geometry.getAttribute('position'),
        pointHighlightPositionShared:this.selectionLines.geometry.getAttribute('position')===this.stars.geometry.getAttribute('position'),
        constellationAnchorUtDaysJ2000:Number.isFinite(this.lastStarEpoch)?this.lastStarEpoch:null,directionBufferBytes:this.starDirections.byteLength,
        motionCacheBoundArcsec:STAR_MOTION_CACHE_BOUND_ARCSEC,float32DirectionBoundArcsec:STAR_FLOAT32_DIRECTION_BOUND_ARCSEC,combinedDirectionBoundArcsec:STAR_CACHE_DIRECTION_BOUND_ARCSEC,
        boundScope:'fixed-source EQJ motion cache plus normalized Float32 rounding; excludes measurement errors, aberration/parallax and pixel projection'},
      gesture:{activePointerIds:gestureActiveContacts(this.gesture).map(pointer=>pointer.id),ignoredPointerIds:[...this.gesture.pointers.values()].filter(pointer=>!pointer.active).map(pointer=>pointer.id),
        capturedPointerIds:[...this.capturedPointers].filter(id=>this.canvas.hasPointerCapture(id)),mode:gestureMode(this.gesture),tapSuppressed:this.gesture.tapSuppressed,viewMode:this.gestureView},
      graphicsContextState:this.disposed?'disposed':this.contextLost?'lost':'active',
      runtimeQuality:{...this.runtimeQuality},runtimeQualityCapabilities:this.getRuntimeQualityCapabilities(),stageInputEnabled:this.stageInputEnabled,
      runtimeQualityConsumption:{budgetClass:this.budgetClass,baselinePixelRatio:this.baselineRatio,effectivePixelRatio:this.ratio,baselineBackingSize:[Math.floor(this.width*this.baselineRatio),Math.floor(this.height*this.baselineRatio)],
        actualBackingSize:[this.canvas.width,this.canvas.height],labelBackingSize:[this.labels.canvas.width,this.labels.canvas.height],cssViewportSize:[this.width,this.height],starDprUniform:this.starMaterial.uniforms.uDpr!.value,
        ordinaryBackCandidatesSkipped:this.qualityBackLabelsSkipped,ordinarySecondaryCandidatesOmitted:this.qualitySecondaryLabelsOmitted,decorationReductionApplied:false,optionalStarsOmitted:false},
      earthLayers:{dayEnabled:this.earth.material.uniforms.uDayEnabled!.value===1,nightEnabled:this.earth.material.uniforms.uNightEnabled!.value===1,
        cloudEnabled:this.earth.material.uniforms.uCloudEnabled!.value===1,dayTextureReady:this.earth.material.uniforms.uHasDay!.value===1,meshVisible:this.earthGroup.visible,
        geometryId:this.earth.geometry.uuid,materialId:this.earth.material.uuid,dayTextureId:(this.earth.material.uniforms.uDay!.value as THREE.Texture).uuid,
        opaque:!this.earth.material.transparent,depthWrite:this.earth.material.depthWrite},
      visibleBodyIds:[...this.bodies].filter(([,mesh])=>mesh.visible).map(([id])=>`body:${id}`)};
  }
  getSkyAppearanceDiagnostics(){
    const uniforms=(this.background.material as THREE.ShaderMaterial).uniforms,texture=uniforms.uMilkyWay!.value as THREE.Texture;
    const image=texture.image as {width?:number;height?:number}|undefined;
    const resident=[...this.resources].filter(candidate=>candidate.userData.assetSlot==='uMilkyWay');
    const inverse=uniforms.uFrameInverse!.value as THREE.Matrix3;
    const directionSamples=milkyWayDirections.map(sample=>{
      const eqj=sample.directionEqj as unknown as Vec3,worldDirection=this.displayVector(eqj),target=worldDirection.clone().multiplyScalar(this.finite?1:100);
      if(!this.finite)target.add(this.camera.position);
      const local=target.clone().applyMatrix4(this.camera.matrixWorldInverse),p=target.clone().project(this.camera);
      return {id:sample.id,directionEqj:eqj,geometricDirectionDisplay:multiplyVector(this.frame,eqj),actualDirectionDisplay:worldDirection.toArray(),uv:milkyWayUv(eqj),projectedNdc:local.z<0?[p.x,p.y]:null,
        nearHemisphere:this.finite?sphereFacing(worldDirection.toArray(),this.camera.position.toArray())>0:null,
        visible:!!(this.state&&this.projectDirection(eqj,this.state))};
    });
    return {utDaysJ2000:this.snapshot?.utDaysJ2000??null,model:this.skyAppearance,refraction:this.refractionBridge.getDiagnostics(),
      uniforms:{limitingMagnitude:this.starMaterial.uniforms.uLimit!.value as number,starVisibility:this.starMaterial.uniforms.uVisibility!.value as number,
        milkyWayContrast:uniforms.uMilkyWayContrast!.value as number,backgroundLinearRgb:(uniforms.uBackgroundLinearRgb!.value as THREE.Vector3).toArray(),horizonGlowLinearRgb:(uniforms.uHorizonGlowLinearRgb!.value as THREE.Vector3).toArray()},
      milkyWayEnabled:uniforms.uMilkyWayEnabled!.value===1,textureLoaded:uniforms.uHasMilkyWay!.value===1,
      textureTier:this.milkyWayTier,requestedTextureTier:this.requestedMilkyWayTier,textureId:texture.uuid,textureDimensions:[image?.width??0,image?.height??0],
      residentMilkyWayTextureCount:resident.length,residentMilkyWayTextureIds:resident.map(candidate=>candidate.uuid),ownedTextureCount:this.resources.size,
      backgroundGeometryId:this.background.geometry.uuid,finiteMode:this.finite,frameToDisplay:this.frame,
      nearGalaxyGeometryId:this.galaxyNear.geometry.uuid,nearGalaxyPassVisible:this.galaxyNear.visible,nearGalaxySharesTextureUniform:this.galaxyNear.material.uniforms.uMilkyWay===uniforms.uMilkyWay,
      finiteNearBlend:'display-space-additive-approximation',finiteFarBlend:'linear-radiance-in-background',
      inverseFrameToEqj:[inverse.elements.slice(0,9).filter((_,i)=>i%3===0),inverse.elements.slice(0,9).filter((_,i)=>i%3===1),inverse.elements.slice(0,9).filter((_,i)=>i%3===2)],
      sharedFrameMatchesInverse:inverse.clone().transpose().equals(this.sharedUniforms.uFrame.value),textureProjectionMetadata:milkyWayMetadata,
      directionSamples,radianceGain:.085,colorSaturation:.15,farHemisphereWeight:this.sharedUniforms.uBackAlpha.value};
  }
  private referenceId(reference:object):number {let id=this.referenceIds.get(reference);if(id===undefined){id=this.nextReferenceId++;this.referenceIds.set(reference,id);}return id;}

  private pickStarAt(x:number,y:number):ObjectId|null {
    if(!this.state)return null;
    const limit=this.starMaterial.uniforms.uLimit!.value as number,visibility=this.starMaterial.uniforms.uVisibility!.value as number;
    if(visibility<.05)return null;
    let hit:ObjectId|null=null,best=10;
    for(const star of catalog.stars){if(star.magnitude>limit)continue;const i=star.index*3,p=this.projectDirection([this.starDirections[i]!,this.starDirections[i+1]!,this.starDirections[i+2]!],this.state);if(!p)continue;const distance=Math.hypot(p.x-x,p.y-y);if(distance<best){best=distance;hit=star.id;}}
    return hit;
  }
  private pickBodyAt(x:number,y:number):ObjectId|null {
    if(!this.state)return null;
    if(this.groundDiscs.size){
      const cameraRay=(x:number,y:number)=>new THREE.Vector3((x*2/this.width-1)*this.camera.aspect*Math.tan(this.camera.fov*RAD/2),(1-y*2/this.height)*Math.tan(this.camera.fov*RAD/2),-1).normalize().applyQuaternion(this.camera.quaternion);
      // Exact inverse-ray mask. A separate 4 CSS px allowance samples neighbouring display rays;
      // it does not turn a conservative rectangle or max radius into the physical mask.
      for(const [dx,dy] of [[0,0],[4,0],[-4,0],[0,4],[0,-4]]){
        for(const [id,{disc,bounds}] of [...this.groundDiscs].reverse()){if(!bounds||!this.bodies.get(id)?.visible)continue;
          const ray=cameraRay(x+dx!,y+dy!);if(this.state.layers.terrain&&ray.y<hillHeight(ray))continue;
          const p=inverseDiscCoordinates(ray.toArray(),disc);if(p&&p[0]*p[0]+p[1]*p[1]<=1)return `body:${id}` as ObjectId;
        }
      }return null;
    }
    return [...this.projectedBodies].reverse().find(body=>Math.hypot(body.x-x,body.y-y)<body.radius)?.id??null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if(!this.stageInputEnabled||event.button!==0||!this.state||this.disposed||this.contextLost||this.uiBlocksPoint(event.clientX,event.clientY))return;
    if(this.gestureView!==null&&this.gestureView!==this.state.viewMode)this.clearGesture();
    event.preventDefault();this.gestureView=this.state.viewMode;
    this.applyPointerInput({type:'down',id:event.pointerId,x:event.clientX,y:event.clientY});this.canvas.focus({preventScroll:true});
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    if(!this.validGestureView())return;
    this.applyPointerInput({type:'move',id:event.pointerId,x:event.clientX,y:event.clientY});
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if(!this.validGestureView())return;
    this.applyPointerInput({type:'up',id:event.pointerId,x:event.clientX,y:event.clientY});
  };
  private readonly onPointerCancel=(event:PointerEvent):void=>{this.applyPointerInput({type:'cancel',id:event.pointerId,x:event.clientX,y:event.clientY});};
  private readonly onLostPointerCapture=(event:PointerEvent):void=>{this.applyPointerInput({type:'lost-capture',id:event.pointerId,x:event.clientX,y:event.clientY});};
  private readonly onWindowBlur=():void=>{this.clearGesture();};
  private readonly onVisibilityChange=():void=>{if(document.hidden)this.clearGesture();};
  private validGestureView():boolean {
    if(!this.stageInputEnabled||!this.state||this.disposed||this.contextLost||this.gestureView!==this.state.viewMode){this.clearGesture();return false;}return true;
  }
  private uiBlocksPoint(x:number,y:number):boolean {
    if(this.loupeViewport&&x>=this.loupeViewport.left&&x<=this.loupeViewport.left+this.loupeViewport.width&&y>=this.loupeViewport.top&&y<=this.loupeViewport.top+this.loupeViewport.height)return true;
    const stage=this.container.getBoundingClientRect(),localX=x-stage.left,localY=y-stage.top;
    return readSkyOcclusions(this.container).some(rect=>localX>=rect.left&&localX<=rect.right&&localY>=rect.top&&localY<=rect.bottom);
  }
  private releasePointer(id:number):void {
    this.capturedPointers.delete(id);
    try{if(this.canvas?.hasPointerCapture(id))this.canvas.releasePointerCapture(id);}catch{/* Native pointer may already have ended. */}
  }
  private clearGesture():void {
    const ids=new Set([...this.gesture.pointers.keys(),...this.capturedPointers]);this.gesture=createPointerGesture();this.gestureView=null;
    for(const id of ids)this.releasePointer(id);
  }
  resetPointerGestures():void {this.clearGesture();}
  private applyPointerInput(input:PointerGestureInput):void {
    const result=reducePointerGesture(this.gesture,input);this.gesture=result.state;if(!this.gesture.pointers.size)this.gestureView=null;
    for(const id of result.releaseIds)this.releasePointer(id);
    for(const id of result.captureIds)try{this.canvas.setPointerCapture(id);this.capturedPointers.add(id);}catch{/* Synthetic inputs have no native capture; state remains bounded. */}
    if(!this.stageInputEnabled||!result.action||!this.state||this.contextLost||this.disposed)return;
    if(result.action.type==='pan'){if(applyCameraPan(this.state,result.action.dx,result.action.dy,this.height))this.onCameraChange();}
    else if(result.action.type==='zoom'){if(applyCameraZoom(this.state,result.action.scale))this.onCameraChange();}
    else if(!this.uiBlocksPoint(result.action.x,result.action.y)){
      const bounds=this.canvas.getBoundingClientRect(),x=result.action.x-bounds.left,y=result.action.y-bounds.top;
      const label=this.labels.hitTest(x,y),labelObject=label&&/^(hip|hyg|body|constellation):/.test(label)?label as ObjectId:null;
      const body=this.pickBodyAt(x,y);this.onSelect?.(labelObject??body??this.pickStarAt(x,y));
    }
  }
  private readonly onWheel = (event: WheelEvent): void => {
    if(!this.stageInputEnabled||!this.state||this.contextLost||this.disposed||this.uiBlocksPoint(event.clientX,event.clientY))return;
    event.preventDefault();this.clearGesture();
    const scale = Math.exp(THREE.MathUtils.clamp(event.deltaY, -300, 300) * .001);
    if(applyCameraZoom(this.state,scale))this.onCameraChange();
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.stageInputEnabled||!this.state||this.contextLost||this.disposed || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Escape'].includes(event.key)) return;
    event.preventDefault();this.clearGesture();
    if (event.key === 'Escape') this.onSelect?.(null);
    else if (this.state.viewMode === 'ground') {
      const camera = this.state.cameras.ground;
      if (event.key === 'ArrowLeft') camera.azimuthDegNorthEast -= 5;
      if (event.key === 'ArrowRight') camera.azimuthDegNorthEast += 5;
      camera.azimuthDegNorthEast = ((camera.azimuthDegNorthEast % 360) + 360) % 360;
      if (event.key === 'ArrowUp') camera.altitudeDeg = Math.min(90, camera.altitudeDeg + 5);
      if (event.key === 'ArrowDown') camera.altitudeDeg = Math.max(-90, camera.altitudeDeg - 5);
      if (event.key === '+' || event.key === '-') camera.verticalFovDeg = THREE.MathUtils.clamp(camera.verticalFovDeg * (event.key === '+' ? .9 : 1.1), 20, 100);
    } else {
      const camera = this.state.cameras[this.state.viewMode];
      const q = new THREE.Quaternion().fromArray(camera.orientationQuaternion);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), event.key === 'ArrowLeft' ? -.08 : .08));
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), event.key === 'ArrowUp' ? -.08 : .08));
      camera.orientationQuaternion = q.normalize().toArray();
      if (event.key === '+' || event.key === '-') {const limits=EXTERNAL_CAMERA_LIMITS[this.state.viewMode];camera.distanceDisplayUnits = THREE.MathUtils.clamp(camera.distanceDisplayUnits * (event.key === '+' ? .9 : 1.1),limits.minDistance,limits.maxDistance);}
    }
    this.onCameraChange();
  };
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();if(this.disposed)return;this.contextLost=true;this.clearGesture();this.container.dataset.graphicsWarning='图形上下文中断，正在等待恢复';
    this.onContextState?.('lost');this.onCameraChange();
  };
  private readonly onContextRestored = (): void => {
    if(this.disposed)return;this.contextLost=false;this.clearGesture();delete this.container.dataset.graphicsWarning;
    // Three registered its restoration listener first and has rebuilt the existing renderer here.
    this.refractionBridge.texture.needsUpdate=true;
    this.onContextState?.('restored');this.onCameraChange();
  };

  getMetrics(): Partial<RuntimeMetrics> {
    const sorted = [...this.frameSamples].sort((a, b) => a - b), percentile = (p: number): number => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
    let textureBytes = 0; for (const texture of this.resources) { const image = texture.image as { width?: number; height?: number } | undefined; textureBytes += (image?.width ?? 1) * (image?.height ?? 1) * (texture.userData.refractionLut?8:4) * (texture.generateMipmaps ? 4 / 3 : 1); }
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    return { samplingWindowSeconds: 0, frameMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }, drawCallsPerFrame: this.renderer.info.render.calls,
      visibleLabelCount: this.labels.visibleCount, textureCount: this.renderer.info.memory.textures, geometryCount: this.renderer.info.memory.geometries,
      appOwnedGpuBytesEstimate: Math.round(textureBytes + this.canvas.width * this.canvas.height * 8 + this.arcBuffer.positions.byteLength + catalog.magnitudes.byteLength + catalog.colors.byteLength + this.arcBuffer.ordinaryIndex.byteLength + this.arcBuffer.highlightIndex.byteLength + this.referencePositions.byteLength + this.referenceColors.byteLength + this.referenceClasses.byteLength + 1_500_000), mainThreadJsHeapBytes: heap,
      measurementNotes: ['frameMs为最近240次render的CPU提交与标签耗时，非GPU帧时间或显示帧间隔。', `WebGL ${this.canvas.width}×${this.canvas.height}；DPR ${this.ratio.toFixed(2)}；GPU估算含纹理mipmap/几何/默认颜色与深度buffer，驱动内部开销未计。`, 'Canvas2D标签画布与至多4MiB glyph位图另计于rendererDiagnostics.labelRasterBytesTotal；不混作实测GPU显存。'] };
  }
  capture(appearance?:SkyAppearance): string {
    if (this.state && this.snapshot) this.render(this.state, this.snapshot,appearance??this.skyAppearance??undefined);
    const output = document.createElement('canvas'); output.width = this.labels.canvas.width; output.height = this.labels.canvas.height;
    const context = output.getContext('2d')!; context.drawImage(this.canvas, 0, 0,output.width,output.height); context.drawImage(this.labels.canvas, 0, 0,output.width,output.height);
    if(this.loupeViewport&&this.loupeDiameter){
      const bounds=this.canvas.getBoundingClientRect(),rect=this.loupeViewport,diag=this.getMoonLoupeDiagnostics();
      context.save();context.scale(output.width/this.width,output.height/this.height);context.font='10px "Microsoft YaHei",sans-serif';context.fillStyle='#c8dfed';context.textAlign='center';
      context.fillText(`教学 ×${diag.magnificationRelativeToMain?.toFixed(1)} · 视场中心角比例`,rect.left-bounds.left+rect.width/2,rect.top-bounds.top+rect.height-4);context.restore();
    }
    return output.toDataURL('image/png');
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;this.clearGesture(); this.resizeObserver?.disconnect();
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown); this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerup', this.onPointerUp); this.canvas?.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas?.removeEventListener('lostpointercapture',this.onLostPointerCapture);
    this.canvas?.removeEventListener('wheel', this.onWheel); this.canvas?.removeEventListener('keydown', this.onKeyDown);
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost); this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);
    window.removeEventListener('blur',this.onWindowBlur);document.removeEventListener('visibilitychange',this.onVisibilityChange);
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    this.scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) { geometries.add(object.geometry); for (const m of Array.isArray(object.material) ? object.material : [object.material]) materials.add(m); } });
    geometries.add(this.physicalSunGeometry);geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); this.resources.forEach(t => t.dispose());
    // Detach host callbacks before deliberately releasing the only owned WebGL context.
    this.renderer.forceContextLoss();this.renderer.dispose(); this.canvas?.remove(); this.labels?.dispose(); this.frameSamples.length = 0;
  }
}
