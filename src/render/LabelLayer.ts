import { readSkyOcclusions, SKY_OCCLUDER_SELECTOR } from './Occlusion';
import {isProtectedRuntimeLabel} from './RenderQuality';

export interface LabelCandidate {
  id: string; text: string; secondary?: string; x: number; y: number; priority: number;
  color?: string; alpha?: number; selected?: boolean; qualityProtected?:boolean;
}
export interface LabelBox { x: number; y: number; w: number; h: number }
export interface LabelHitBox extends LabelBox { id: string }
interface Placement { offset: number; lastSeen: number; hiddenSince: number | null }
interface Glyph { canvas: HTMLCanvasElement; width: number; height: number; bytes: number }
const intersects = (a: LabelBox,b: LabelBox): boolean => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;

/** One Canvas2D overlay with bounded 4 MiB raster text and retained 10 Hz placement choices. */
export class LabelLayer {
  readonly canvas=document.createElement('canvas');
  private readonly context=this.canvas.getContext('2d')!;
  private readonly widths=new Map<string,number>();
  private readonly glyphs=new Map<string,Glyph>();
  private glyphBytes=0;
  private readonly placements=new Map<string,Placement>();
  private readonly observer: MutationObserver;
  private readonly resizeObserver:ResizeObserver;
  private readonly onLayoutChange:()=>void;
  private observedElements=new Set<Element>();
  private seenCandidates=new Set<string>();
  private layoutCount=0;
  private nextLayoutMs=0;
  private lastLayoutSignature='';
  private blocked:LabelBox[]=[];
  private width=1;
  private height=1;
  private ratio=1;
  private hitBoxes:LabelHitBox[]=[];
  private ordinaryVisibleCount=0;
  private protectedVisibleCount=0;
  private ordinaryBudget=0;
  private measuredWidthCount=0;
  private widthLookupCount=0;
  private rasterizedGlyphCount=0;
  private candidateCount=0;
  private secondaryCandidateCount=0;
  visibleCount=0;
  constructor(private readonly container:HTMLElement,onOcclusionChange:()=>void=()=>{}) {
    this.canvas.className='sky-label-canvas';
    Object.assign(this.canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none'});
    container.append(this.canvas);
    const changed=()=>{this.invalidateLayout();onOcclusionChange();};
    this.onLayoutChange=changed;
    this.observer=new MutationObserver(records=>{if(records.some(record=>record.oldValue!==(record.target as Element).getAttribute(record.attributeName!)))changed();});
    this.resizeObserver=new ResizeObserver(changed);
    this.syncOcclusionObservers();
    window.addEventListener('sky:layout-change',this.onLayoutChange);
  }
  private syncOcclusionObservers():void {
    // GraphicsHost is constructed before mountControls. Bind actual boxes on
    // first draw, then only rebuild observers when this bounded DOM set changes.
    const controls=document.querySelector('#controls'),current=new Set<Element>();
    if(controls)current.add(controls);
    for(const element of document.querySelectorAll<HTMLElement>(SKY_OCCLUDER_SELECTOR))if(element.dataset.canvasSkyHud!=='true')current.add(element);
    if(current.size===this.observedElements.size&&[...current].every(element=>this.observedElements.has(element)))return;
    for(const element of this.observedElements)if(!current.has(element))this.resizeObserver.unobserve(element);
    this.observer.disconnect();
    for(const element of current) {
      if(!this.observedElements.has(element))this.resizeObserver.observe(element);
      if(element===controls||!controls?.contains(element))this.observer.observe(element,{attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','open','data-sky-dock'],subtree:true});
    }
    this.observedElements=current;this.invalidateLayout();
  }
  invalidateLayout():void {this.nextLayoutMs=0;}
  resize(width:number,height:number,ratio:number):void {
    this.width=width;this.height=height;
    if(ratio!==this.ratio){this.glyphs.clear();this.glyphBytes=0;}
    this.ratio=ratio;this.canvas.width=Math.round(width*ratio);this.canvas.height=Math.round(height*ratio);
    this.invalidateLayout();
  }
  private measure(text:string,size:number,bold=false):number {
    this.widthLookupCount++;
    const key=`${size}:${bold}:${text}`;
    if(!this.widths.has(key)) {
      this.measuredWidthCount++;
      this.context.font=`${bold?'600':'400'} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      this.widths.set(key,this.context.measureText(text).width);
      if(this.widths.size>768) this.widths.delete(this.widths.keys().next().value!);
    }
    return this.widths.get(key)!;
  }
  private glyph(text:string,size:number,color:string,bold=false):Glyph {
    const key=`${size}:${color}:${bold}:${text}`;
    let glyph=this.glyphs.get(key);
    if(glyph) {this.glyphs.delete(key);this.glyphs.set(key,glyph);return glyph;}
    const width=Math.ceil(this.measure(text,size,bold))+6,height=size+8;
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*this.ratio);canvas.height=Math.ceil(height*this.ratio);
    const ctx=canvas.getContext('2d')!;ctx.scale(this.ratio,this.ratio);
    this.rasterizedGlyphCount++;
    ctx.font=`${bold?'600':'400'} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.fillStyle=color;ctx.textBaseline='top';ctx.shadowColor='#020407';ctx.shadowBlur=2;ctx.fillText(text,3,3);
    glyph={canvas,width,height,bytes:canvas.width*canvas.height*4};
    while(this.glyphBytes+glyph.bytes>4*1024*1024&&this.glyphs.size){const oldest=this.glyphs.keys().next().value!;this.glyphBytes-=this.glyphs.get(oldest)!.bytes;this.glyphs.delete(oldest);}
    this.glyphs.set(key,glyph);this.glyphBytes+=glyph.bytes;return glyph;
  }
  private updateBlockedRects():void {
    this.blocked=readSkyOcclusions(this.container).map(r=>({x:r.left-4,y:r.top-4,w:r.right-r.left+8,h:r.bottom-r.top+8}));
  }
  draw(candidates:LabelCandidate[],reference:boolean,maxLabels:number,ordinaryMaxLabels=maxLabels):void {
    this.syncOcclusionObservers();
    const now=performance.now(),size=reference?11:13;
    const signature=`${reference}:${maxLabels}:${ordinaryMaxLabels}:${candidates.filter(c=>c.selected).map(c=>c.id).join('|')}`;
    const currentCandidates=new Set(candidates.map(c=>c.id));
    const layout=now>=this.nextLayoutMs||signature!==this.lastLayoutSignature||candidates.some(c=>!this.seenCandidates.has(c.id));
    this.seenCandidates=currentCandidates;
    if(layout){this.layoutCount++;this.nextLayoutMs=now+100;this.lastLayoutSignature=signature;this.updateBlockedRects();}
    const ctx=this.context;ctx.setTransform(this.ratio,0,0,this.ratio,0,0);ctx.clearRect(0,0,this.width,this.height);
    const grid=new Map<string,LabelBox[]>();this.hitBoxes=[];this.visibleCount=0;this.ordinaryVisibleCount=0;this.protectedVisibleCount=0;
    this.ordinaryBudget=ordinaryMaxLabels;this.candidateCount=candidates.length;this.secondaryCandidateCount=candidates.filter(c=>!!c.secondary).length;
    candidates.sort((a,b)=>Number(isProtectedRuntimeLabel(b))-Number(isProtectedRuntimeLabel(a))||(b.priority+(this.placements.has(b.id)?.25:0))-(a.priority+(this.placements.has(a.id)?.25:0))||a.id.localeCompare(b.id));
    for(const label of candidates) {
      const protectedLabel=isProtectedRuntimeLabel(label);
      if(this.ordinaryVisibleCount>=ordinaryMaxLabels&&!protectedLabel) continue;
      const existing=this.placements.get(label.id);
      if(existing) existing.lastSeen=now;
      if(!layout&&!existing) continue;
      const textWidth=Math.max(this.measure(label.text,size,label.selected),label.secondary?this.measure(label.secondary,size-3):0);
      const height=label.secondary?size*2+3:size+6;
      const offsets=[[8,-height/2],[-textWidth-8,-height/2],[-textWidth/2,9],[-textWidth/2,-height-9]];
      const previous=existing?.offset??0;
      const allowMove=label.selected||!existing||existing.hiddenSince!==null&&now-existing.hiddenSince>200;
      const choices=layout&&allowMove?[previous,...[0,1,2,3].filter(i=>i!==previous)]:[previous];
      let box:LabelBox|null=null,choice=previous;
      for(const index of choices) {
        const offset=offsets[index]!;
        const candidate={x:label.x+offset[0]!-3,y:label.y+offset[1]!-3,w:textWidth+6,h:height+6};
        if(candidate.x<6||candidate.y<6||candidate.x+candidate.w>this.width-6||candidate.y+candidate.h>this.height-8||this.blocked.some(r=>intersects(candidate,r))) continue;
        let collision=false;
        for(let gx=Math.floor(candidate.x/48);gx<=Math.floor((candidate.x+candidate.w)/48);gx++) for(let gy=Math.floor(candidate.y/48);gy<=Math.floor((candidate.y+candidate.h)/48);gy++) {
          if((grid.get(`${gx},${gy}`)??[]).some(other=>intersects(candidate,other))) collision=true;
        }
        if(!collision){box=candidate;choice=index;break;}
      }
      if(!box){if(existing&&existing.hiddenSince===null)existing.hiddenSince=now;continue;}
      this.placements.set(label.id,{offset:choice,lastSeen:now,hiddenSince:null});
      for(let gx=Math.floor(box.x/48);gx<=Math.floor((box.x+box.w)/48);gx++) for(let gy=Math.floor(box.y/48);gy<=Math.floor((box.y+box.h)/48);gy++) {const key=`${gx},${gy}`,cell=grid.get(key)??[];cell.push(box);grid.set(key,cell);}
      ctx.globalAlpha=label.alpha??1;
      const glyph=this.glyph(label.text,size,label.color??'#d8d6c6',label.selected);
      ctx.drawImage(glyph.canvas,box.x,box.y,glyph.width,glyph.height);
      if(label.secondary){const sub=this.glyph(label.secondary,size-3,'#8b959f');ctx.drawImage(sub.canvas,box.x,box.y+size+3,sub.width,sub.height);}
      this.hitBoxes.push({...box,id:label.id});this.visibleCount++;if(protectedLabel)this.protectedVisibleCount++;else this.ordinaryVisibleCount++;
    }
    ctx.globalAlpha=1;
    for(const [id,placement] of this.placements) if(now-placement.lastSeen>2000)this.placements.delete(id);
    while(this.placements.size>512)this.placements.delete(this.placements.keys().next().value!);
  }
  hitTest(x:number,y:number):string|null {return this.hitBoxes.find(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h)?.id??null;}
  getVisibleHitBoxes():LabelHitBox[]{return this.hitBoxes.map(box=>({...box}));}
  getBlockedRects():LabelBox[]{return this.blocked.map(box=>({...box}));}
  getCacheMetrics(){const labelCanvasBytes=this.canvas.width*this.canvas.height*4;return{glyphBytes:this.glyphBytes,glyphCount:this.glyphs.size,placementCount:this.placements.size,layoutCount:this.layoutCount,labelCanvasBytes,labelRasterBytesTotal:labelCanvasBytes+this.glyphBytes,occlusionObserverTargetCount:this.observedElements.size,
    ordinaryVisibleCount:this.ordinaryVisibleCount,protectedVisibleCount:this.protectedVisibleCount,ordinaryBudget:this.ordinaryBudget,candidateCount:this.candidateCount,secondaryCandidateCount:this.secondaryCandidateCount,
    measuredWidthCount:this.measuredWidthCount,widthLookupCount:this.widthLookupCount,rasterizedGlyphCount:this.rasterizedGlyphCount,labelPixelRatio:this.ratio};}
  dispose():void {window.removeEventListener('sky:layout-change',this.onLayoutChange);this.observer.disconnect();this.resizeObserver.disconnect();this.observedElements.clear();this.canvas.remove();this.widths.clear();this.glyphs.clear();this.placements.clear();this.seenCandidates.clear();}
}
