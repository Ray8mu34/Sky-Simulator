import chinese from '../../assets/runtime/chinese-sky.json';
import boundaries from '../../assets/runtime/iau-boundaries.json';
import type {ScienceSnapshot,SimulationState,Vec3} from '../contracts';
import type {StarCatalog} from '../data/types';
import {applyMatrix,raDecToVector,transposeMatrix,horizontalToVector,normalize} from '../core/math';
import {motionTrack} from '../core/observation-tools';
type Point={x:number;y:number;alpha?:number};
type Project=(v:Vec3)=>Point|null;
const boundaryPaths=boundaries.map(arc=>arc.points.map(p=>raDecToVector(p[0]!,p[1]!)));
const figures=chinese.filter(f=>f.pairs.length).map(figure=>({...figure,paths:figure.pairs.map(pair=>pair.map(p=>raDecToVector(p[0]!,p[1]!))),anchor:normalize(figure.pairs.flat().reduce((v,p)=>{const d=raDecToVector(p[0]!,p[1]!);return [v[0]!+d[0],v[1]!+d[1],v[2]!+d[2]];},[0,0,0]) as unknown as Vec3)}));
export class TeachingOverlays {
  private trackKey='';private track:Vec3[]=[];
  draw(ctx:CanvasRenderingContext2D,state:SimulationState,snapshot:ScienceSnapshot,catalog:StarCatalog,project:Project,width:number,height:number,blocked:(x:number,y:number)=>boolean):void {
    ctx.save();ctx.lineWidth=.65;ctx.font='11px "Microsoft YaHei",sans-serif';
    const path=(points:readonly Vec3[],color:string)=>{
      ctx.strokeStyle=color;ctx.beginPath();let previous:Point|null=null;
      for(const v of points){const p=project(v);if(!p||blocked(p.x,p.y)){previous=null;continue;}
        if(previous&&Math.hypot(p.x-previous.x,p.y-previous.y)<Math.min(width,height)*.16)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);previous=p;}
      ctx.stroke();
    };
    const grid=(transform:(lon:number,lat:number)=>Vec3,color:string)=>{
      for(let lat=-60;lat<=60;lat+=30)path(Array.from({length:181},(_,i)=>transform(i*2,lat)),color);
      for(let lon=0;lon<360;lon+=30)path(Array.from({length:91},(_,i)=>transform(lon,-90+i*2)),color);
      for(let lon=0;lon<360;lon+=30){const p=project(transform(lon,0));if(p&&!blocked(p.x,p.y)){ctx.fillStyle=color;ctx.fillText(`${lon}°`,p.x+3,p.y-3);}}
    };
    if(state.layers.equatorialGrid)grid((lon,lat)=>raDecToVector(lon/15,lat),'#526b85');
    if(state.layers.horizontalGrid)grid((lon,lat)=>applyMatrix(transposeMatrix(snapshot.eqjToHorizontalGeometric),horizontalToVector(lat,lon)),'#467369');
    if(state.layers.eclipticGrid)grid((lon,lat)=>applyMatrix(snapshot.eclipticOfDateToEqj,raDecToVector(lon/15,lat)),'#8b7950');
    if(state.layers.constellationBoundaries){ctx.setLineDash([3,3]);for(const points of boundaryPaths)path(points,'#62596e');ctx.setLineDash([]);}
    if(state.layers.chineseSky||state.selected?.startsWith('chinese:')){
      const occupied:Point[]=[];
      for(const figure of figures){if(!state.layers.chineseSky&&state.selected!==`chinese:${figure.id}`)continue;for(const pair of figure.paths) {
        const a=pair[0]!,b=pair[1]!;path(Array.from({length:9},(_,i)=>normalize(a.map((v,j)=>v*(1-i/8)+b[j]!*i/8) as unknown as Vec3)),'#a88c60');
      }
        const p=project(figure.anchor);if(p&&!blocked(p.x,p.y)&&!occupied.some(q=>Math.abs(q.x-p.x)<55&&Math.abs(q.y-p.y)<18)){
          ctx.fillStyle='#c6b38d';ctx.fillText(figure.name??figure.english??figure.id,p.x+5,p.y);occupied.push(p);
        }
      }
    }
    if(state.layers.motionTrack&&state.selected){
      const key=JSON.stringify([state.selected,Math.floor(state.time.utDaysJ2000),state.observer]);
      if(key!==this.trackKey){this.trackKey=key;this.track=motionTrack(catalog,{...state,time:{...state.time,utDaysJ2000:Math.floor(state.time.utDaysJ2000)}});}
      ctx.lineWidth=1.3;path(this.track,'#d8ad79');
      for(const [i,label] of [[0,'轨迹起点'],[this.track.length-1,'轨迹终点']] as const){const v=this.track[i],p=v?project(v):null;if(p&&!blocked(p.x,p.y)){ctx.fillStyle='#d8ad79';ctx.fillText(label,p.x+4,p.y-4);}}
    }
    ctx.restore();
  }
}
